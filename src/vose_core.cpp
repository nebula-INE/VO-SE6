//vose_core.cpp
//合成メインエンジン
// --- clamp polyfill (for C++14/macOS libc++) ---
#ifndef HAVE_STD_CLAMP
template <typename T>
constexpr const T& clamp(const T& v, const T& lo, const T& hi) {
    return (v < lo) ? lo : (hi < v) ? hi : v;
}
#endif


#include <vector>
#include <string>
#include <map>
#include <unordered_map>
#include <list>
#include <algorithm>
#include <cmath>
#include <sys/stat.h>
#include <fstream>
#include <iomanip>    
#include <random>
#include <sstream>
#include <cstring>
#include <cstdint>
#include <cstdio>
#include <future>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <memory>
#include <shared_mutex>


// 先に型定義を完了させ、ONNXセッション側での未定義エラーを防ぐ
using VoseMutex = std::mutex;
using VoseUniqueLock = std::unique_lock<std::mutex>;

// --- Windows (MSVC) と POSIX (macOS/Linux) のクロスプラットフォーム吸収マクロ ---
#if defined(_WIN32) || defined(_WIN64)
#  include <io.h>
#  include <process.h>
#  include <direct.h>     // Windowsの_mkdir用
#  define access _access
#  define F_OK 0
#  define mkdir(path, mode) _mkdir(path) // 2引数版をWindows用に1引数ラップ
#else
#  include <unistd.h>
#endif

// _USE_MATH_DEFINES の再定義警告(C4005)および未定義対策
#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// BigVGAN ONNX Runtime
#ifdef VOSE_PRO
#include <onnxruntime_cxx_api.h>
static std::unique_ptr<Ort::Session> g_bigvgan_session;
static VoseMutex                     g_bigvgan_mutex; // 前方で定義済みのため安全
#endif

#include "vose_core.h"
#include "voice_data.h"
// ...existing code...

#include "world/synthesis.h"
#include "world/cheaptrick.h"
#include "world/d4c.h"
#include "world/harvest.h"
#include "world/audioio.h"
#include "world/constantnumbers.h"

// fs::path などは std::string で代用


static std::vector<VoseFrame> g_vocal_timeline;
static VoseMutex g_timeline_mutex;

// ============================================================
// FNV-1a ハッシュ
// ============================================================

static uint64_t fnv1a_hash(const std::string& str) {
    uint64_t hash = 0xcbf29ce484222325ULL;
    for (char c : str) {
        hash ^= static_cast<uint64_t>(c);
        hash *= 0x100000001b3ULL;
    }
    return hash;
}

static std::string generate_cache_hash(const std::string& wav_path) {
    struct stat st;
    if (stat(wav_path.c_str(), &st) == 0) {
        // ファイルが存在する場合: パス + 更新時刻 + サイズでハッシュ
        auto last_time = static_cast<long long>(st.st_mtime);
        auto file_size = static_cast<unsigned long long>(st.st_size);
        std::string seed = wav_path + std::to_string(last_time) + std::to_string(file_size);
        uint64_t h = fnv1a_hash(seed);
        std::stringstream ss;
        ss << std::hex << std::setw(16) << std::setfill('0') << h;
        return ss.str();
    } else {
        // エンベッドボイス（ファイルシステム上に存在しない）:
        uint64_t h = fnv1a_hash(wav_path);
        std::stringstream ss;
        ss << "emb_" << std::hex << std::setw(16) << std::setfill('0') << h;
        return ss.str();
    }
}

// ============================================================
// oto.ini DB
// ============================================================

std::map<std::string, OtoEntry> g_oto_db;
VoseMutex g_oto_db_mutex;

extern "C" void set_oto_data(const OtoEntry* entries, int count) {
    VoseUniqueLock lock(g_oto_db_mutex);
    g_oto_db.clear();
    if (!entries || count <= 0) return;
    for (int i = 0; i < count; ++i)
        g_oto_db[entries[i].alias] = entries[i];
}

// ============================================================
// データ構造
// ============================================================

struct EmbeddedVoice {
    std::string         path;
    std::vector<double> waveform;
    int                 fs;
};

static std::map<std::string, std::shared_ptr<const EmbeddedVoice>> g_voice_db;
VoseMutex g_voice_db_mutex;

struct AnalysisCache {
    std::vector<double> f0;
    std::vector<double> time;
    int                 length    = 0;
    std::vector<double> flat_spec;
    std::vector<double> flat_ap;
    int                 spec_bins = 0;
};

// ============================================================
// AnalysisCacheStore — LRU エビクション付きメモリキャッシュ
//
// 問題: g_analysis_cache が無制限に増える。
//   100音素 × (harvest_len=2000) × (spec_bins=513) × 2配列 × 8byte
//   ≈ 1音素あたり約16MB → 100音素で1.6GB
//
// 解決: 最大エントリ数を kMaxCacheEntries に制限し、
//   LRU（Least Recently Used）で古いエントリを追い出す。
//   アクセス順を std::list で管理し、O(1) エビクションを実現する。
// ============================================================
// VO-SE専用の型定義（既存の定義に合わせて調整してください）
struct AnalysisCache; 

static constexpr size_t kMaxCacheEntries = 64; // 約1GB上限（16MB × 64）

class CacheStore {
    using Key   = std::string;
    using Value = std::shared_ptr<const AnalysisCache>;

private:
    mutable std::shared_mutex mtx;   // ← shared_mutex に変更
    std::list<std::pair<Key, Value>> lru_list;
    std::unordered_map<Key, std::list<std::pair<Key, Value>>::iterator> index;

public:
    // 読み取り（共有ロック＋MRU移動）
    Value get(const Key& key) {
        std::unique_lock<std::shared_mutex> lock(mtx);  // splice は変更操作のため排他ロック
        auto it = index.find(key);
        if (it == index.end()) return nullptr;
        lru_list.splice(lru_list.begin(), lru_list, it->second);
        return it->second->second;
    }

    // 書き込み（排他ロック）
    void put(const Key& key, const Value& val) {
        std::unique_lock<std::shared_mutex> lock(mtx);
        auto it = index.find(key);
        if (it != index.end()) {
            lru_list.erase(it->second);
            index.erase(it);
        }
        lru_list.push_front({key, val});
        index[key] = lru_list.begin();

        while (index.size() > kMaxCacheEntries) {
            auto last = std::prev(lru_list.end());
            index.erase(last->first);
            lru_list.pop_back();
        }
    }

    void erase(const Key& key) {
        std::unique_lock<std::shared_mutex> lock(mtx);
        auto it = index.find(key);
        if (it == index.end()) return;
        lru_list.erase(it->second);
        index.erase(it);
    }

    size_t size() const {
        std::shared_lock<std::shared_mutex> lock(mtx);
        return index.size();
    }

    void clear() {
        std::unique_lock<std::shared_mutex> lock(mtx);
        lru_list.clear();
        index.clear();
    }
};

static CacheStore g_analysis_cache;
static std::mutex g_analysis_cache_mutex;

// ============================================================
// NoteState / NotePrepass
// ============================================================

enum class NoteState : uint8_t { INVALID, NO_VOICE, RENDERABLE };

struct NotePrepass {
    NoteState                            state        = NoteState::INVALID;
    int64_t                              note_samples = 0;
    std::shared_ptr<const EmbeddedVoice> ev;
    std::shared_ptr<const EmbeddedVoice> prev_ev;
    // raw pointer ではなく値コピー。
    // g_oto_db は set_oto_data() で再構築されうるため、
    // ポインタを長命なオブジェクトに保持すると UB になる。
    OtoEntry                             oto          = {};
    bool                                 has_oto      = false;

    NotePrepass() = default;
    NotePrepass(NoteState s, int64_t ns,
                std::shared_ptr<const EmbeddedVoice> e,
                std::shared_ptr<const EmbeddedVoice> pe = nullptr,
                const OtoEntry* o = nullptr)
        : state(s), note_samples(ns), ev(std::move(e)),
          prev_ev(std::move(pe))
    {
        if (o) { oto = *o; has_oto = true; }
    }
};

// ============================================================
// SynthesisScratchPad
// ============================================================


struct SynthesisScratchPad {
    // 平坦化（1次元化）された動的バッファ
    std::vector<double>  flat_spec, flat_ap, spec_tmp;
    std::vector<double*> spec_ptrs, ap_ptrs;
    
    std::vector<double>  f0, time_axis;

    std::vector<double>  flat_spec_prev, flat_ap_prev;
    std::vector<double*> spec_ptrs_prev, ap_ptrs_prev;
    
    std::vector<double>  f0_prev, time_axis_prev;

    std::vector<double>  flat_mod_ap;
    std::vector<double*> mod_ap_ptrs;

    // 実際にバッファとして確保されている「最大サイズ」
    int reserved_f0 = 0;
    int reserved_bins = 0;

    // 【重要】今回の呼び出しにおける「実際の有効なストライド（列数）」を保持
    int current_bins = 0;

    /**
     * @brief スペクトログラム行列のメモリを安全に確保・更新する
     * @param f0_length 要求された時間フレーム数 (行数)
     * @param spec_bins 要求された周波数ビン数 (列数)
     */
    void ensure_spec(int f0_length, int spec_bins) {
        // 今回の有効な列数を記録（データアクセスの安全弁）
        current_bins = spec_bins;

        // 行数または列数が、過去に確保した最大サイズを超えている場合のみリサイズ
        const bool needs_resize = (f0_length > reserved_f0 || spec_bins > reserved_bins);
        
        if (needs_resize) {
            // キャパシティを最大値に更新
            reserved_f0   = std::max(f0_length,  reserved_f0);
            reserved_bins = std::max(spec_bins,  reserved_bins);
            const size_t total = static_cast<size_t>(reserved_f0) * reserved_bins;

            // 1次元バッファの一括リサイズ
            flat_spec     .resize(total); 
            flat_ap       .resize(total);
            spec_tmp      .resize(reserved_bins);
            flat_spec_prev.resize(total); 
            flat_ap_prev  .resize(total);
            flat_mod_ap   .resize(total);

            // ポインタ配列（行ポインタ）の領域確保
            spec_ptrs     .resize(reserved_f0); 
            ap_ptrs       .resize(reserved_f0);
            spec_ptrs_prev.resize(reserved_f0); 
            ap_ptrs_prev  .resize(reserved_f0);
            mod_ap_ptrs   .resize(reserved_f0);
        }

        // 【バグの根本治療】
        // needs_resize の成否に関わらず、呼び出しごとにポインタを毎回再構築する。
        // これにより、reserved_bins (現在のメモリの物理ストライド) に基づく正しい先頭アドレスが
        // 常にすべての行（0 〜 f0_length-1）に保証される。
        for (int i = 0; i < f0_length; ++i) {
            const size_t off = static_cast<size_t>(i) * reserved_bins;
            spec_ptrs     [i] = &flat_spec     [off];
            ap_ptrs       [i] = &flat_ap       [off];
            spec_ptrs_prev[i] = &flat_spec_prev[off];
            ap_ptrs_prev  [i] = &flat_ap_prev  [off];
            mod_ap_ptrs   [i] = &flat_mod_ap   [off];
        }
    }

    /**
     * @brief 2次元配列風に安全にアクセスするためのユーティリティ（デバッグ・安全用）
     * 外部で `spec_ptrs[i][j]` と書く代わりに `at_spec(i, j)` を使うことで、
     * 万が一ストライドが狂っても数値を破壊させない防壁となる。
     */
    inline double& at_spec(int frame, int bin) {
        return flat_spec[static_cast<size_t>(frame) * reserved_bins + bin];
    }

    void ensure_f0(int n) {
        if (n > static_cast<int>(f0.size())) {
            f0.resize(n); 
            time_axis.resize(n);
        }
    }

    void ensure_f0_prev(int n) {
        if (n > static_cast<int>(f0_prev.size())) {
            f0_prev.resize(n); 
            time_axis_prev.resize(n);
        }
    }
};

// スレッドローカルなインスタンス宣言
thread_local SynthesisScratchPad tl_scratch;

// ============================================================
// 定数
// ============================================================

static constexpr int    kFs               = 44100;
static constexpr double kFramePeriod      = 5.0;   // ms
static constexpr double kInv32768         = 1.0 / 32768.0;
static constexpr int    kCrossfadeSamples = static_cast<int>(kFs * 0.030);
static constexpr int    kMaxPitchLength   = 120000;
static constexpr int    kTransitionFrames = static_cast<int>(60.0 / kFramePeriod);

static int64_t note_samples_safe(int p) {
    return (static_cast<int64_t>(p) - 1) * kFramePeriod / 1000.0 * kFs + 1;
}

// ============================================================
// find_voice_ref
// ============================================================

std::shared_ptr<const EmbeddedVoice> find_voice_ref(const char* key)
{
    {
        VoseUniqueLock lock(g_voice_db_mutex);
        auto it = g_voice_db.find(key ? key : "");
        if (it != g_voice_db.end()) return it->second;
    }
    
    // Fallback: load from disk (MEMFS)
    if (key) {
        int audio_len = GetAudioLength(key);
        if (audio_len > 0) {
            auto ev = std::make_shared<EmbeddedVoice>();
            ev->path = key;
            int nbit = 0;
            ev->waveform.resize(audio_len);
            wavread(key, &ev->fs, &nbit, ev->waveform.data());
            
            VoseUniqueLock lock(g_voice_db_mutex);
            g_voice_db[key] = ev;
            return ev;
        }
    }
    return nullptr;
}

// ============================================================
// ディスクキャッシュ
// ============================================================

static std::string get_cache_dir() {
    std::string p = "cache";
    struct stat st;
    if (stat(p.c_str(), &st) != 0) {
        mkdir(p.c_str(), 0755);
    }
    return p;
}

static void save_cache(const std::string& cache_path, const AnalysisCache& cache)
{
    // 書き途中でクラッシュしても破損キャッシュが残らないよう
    // 一時ファイルに書いてからアトミックにリネームする
    std::string tmp_path = cache_path + ".tmp";

    FILE* fp = fopen(tmp_path.c_str(), "wb");
    if (!fp) return;

    bool ok = true;
    VoseCacheHeader header;
    header.magic     = 0x45534F56;
    header.length    = cache.length;
    header.spec_bins = cache.spec_bins;

    ok &= (fwrite(&header,             sizeof(header),  1,            fp) == 1);
    ok &= (fwrite(cache.f0.data(),     sizeof(double),  cache.length, fp) == static_cast<size_t>(cache.length));
    ok &= (fwrite(cache.time.data(),   sizeof(double),  cache.length, fp) == static_cast<size_t>(cache.length));
    const size_t sc = static_cast<size_t>(cache.length) * cache.spec_bins;
    ok &= (fwrite(cache.flat_spec.data(), sizeof(double), sc, fp) == sc);
    ok &= (fwrite(cache.flat_ap.data(),   sizeof(double), sc, fp) == sc);
    fclose(fp);

    if (ok) {
        std::error_code ec;
        rename(tmp_path.c_str(), cache_path.c_str());  // アトミック置換
        // 失敗時はtmpファイルを削除
        // (rename失敗時のエラー処理は省略)
    } else {
        unlink(tmp_path.c_str());  // 書き込み失敗なら一時ファイルを削除
    }
}

static std::shared_ptr<AnalysisCache> load_cache(const std::string& path,
                                                 int expected_spec_bins = 0)
{
    struct stat st;
    if (stat(path.c_str(), &st) != 0) return nullptr;

    std::ifstream ifs(path, std::ios::binary);
    if (!ifs) return nullptr;

    VoseCacheHeader header{};
    if (!ifs.read(reinterpret_cast<char*>(&header), sizeof(header))) return nullptr;

    // マジック検証
    if (header.magic != 0x45534F56) return nullptr;

    // サニティチェック: 長さ・spec_bins が異常値ならキャッシュ破棄（OOM防止）
    if (header.length <= 0 || header.length > 1'000'000) return nullptr;
    if (header.spec_bins <= 0 || header.spec_bins > 65536) return nullptr;

    // spec_bins 互換チェック:
    // fft_size が変わると spec_bins が変わる。異なるサイズのキャッシュを
    // 読み込むと配列の境界外アクセスが起きるため、不一致なら再解析させる。
    if (expected_spec_bins > 0 && header.spec_bins != expected_spec_bins) {
        return nullptr;
    }

    auto cache = std::make_shared<AnalysisCache>();
    cache->length    = header.length;
    cache->spec_bins = header.spec_bins;
    
    // メモリ確保
    cache->f0  .resize(cache->length);
    cache->time.resize(cache->length);
    const size_t sc = static_cast<size_t>(cache->length) * cache->spec_bins;
    cache->flat_spec.resize(sc);
    cache->flat_ap  .resize(sc);

    // 各 read の成否を検証するラムダ
    auto read_check = [&](void* dst, size_t bytes) -> bool {
        return static_cast<bool>(
            ifs.read(reinterpret_cast<char*>(dst), static_cast<std::streamsize>(bytes)));
    };

    // 【最適化】sizeof(double) をコンテナの要素型（sizeof(cache->...[0])）に書き換え、
    // 将来的に float 等に型変更してもバグが出ないよう安全性を担保。
    if (!read_check(cache->f0.data(),        sizeof(cache->f0[0]) * cache->length))  return nullptr;
    if (!read_check(cache->time.data(),      sizeof(cache->time[0]) * cache->length)) return nullptr;
    if (!read_check(cache->flat_spec.data(), sizeof(cache->flat_spec[0]) * sc))      return nullptr;
    if (!read_check(cache->flat_ap.data(),   sizeof(cache->flat_ap[0]) * sc))        return nullptr;

    // ストリームが正確に末尾に達しているか確認（余剰バイトがある = ファイル破損とみなす）
    if (ifs.peek() != std::ifstream::traits_type::eof()) return nullptr;

    return cache;
}
// ============================================================
// build_analysis_cache
// ============================================================

static std::shared_ptr<const AnalysisCache>
build_analysis_cache(const EmbeddedVoice& ev, int fft_size, int spec_bins)
{
    auto cache = std::make_shared<AnalysisCache>();
    cache->spec_bins = spec_bins;

    HarvestOption opt;
    InitializeHarvestOption(&opt);
    opt.frame_period = kFramePeriod;
    opt.f0_floor     = 50.0;
    opt.f0_ceil      = 800.0;

    const int wav_len     = static_cast<int>(ev.waveform.size());
    const int harvest_len = GetSamplesForHarvest(ev.fs, wav_len, kFramePeriod);
    cache->f0.resize(harvest_len);
    cache->time.resize(harvest_len);
    cache->length = harvest_len;

    Harvest(ev.waveform.data(), wav_len, ev.fs, &opt,
            cache->time.data(), cache->f0.data());

    // F0補完: 無声区間を前後の有声値で線形補間
    {
        std::vector<int> vi;
        vi.reserve(harvest_len);
        for (int i = 0; i < harvest_len; ++i)
            if (cache->f0[i] > 0.0) vi.push_back(i);

        if (!vi.empty()) {
            for (int i = 0; i < vi.front(); ++i)
                cache->f0[i] = cache->f0[vi.front()];
            for (int i = vi.back()+1; i < harvest_len; ++i)
                cache->f0[i] = cache->f0[vi.back()];
            for (int v = 0; v+1 < static_cast<int>(vi.size()); ++v) {
                const int ia = vi[v], ib = vi[v+1];
                if (ib-ia <= 1) continue;
                const double fa = cache->f0[ia], fb = cache->f0[ib];
                for (int i = ia+1; i < ib; ++i)
                    cache->f0[i] = fa + static_cast<double>(i-ia)/(ib-ia)*(fb-fa);
            }
        } else {
            std::fill(cache->f0.begin(), cache->f0.end(), 440.0);
        }
    }

    const size_t sc = static_cast<size_t>(harvest_len) * spec_bins;
    cache->flat_spec.resize(sc);
    cache->flat_ap  .resize(sc);

    std::vector<double*> sp(harvest_len), ap(harvest_len);
    for (int i = 0; i < harvest_len; ++i) {
        sp[i] = &cache->flat_spec[static_cast<size_t>(i)*spec_bins];
        ap[i] = &cache->flat_ap  [static_cast<size_t>(i)*spec_bins];
    }
    CheapTrick(ev.waveform.data(), wav_len, ev.fs,
               cache->time.data(), cache->f0.data(), harvest_len, nullptr, sp.data());
    D4C(ev.waveform.data(), wav_len, ev.fs,
        cache->time.data(), cache->f0.data(), harvest_len, fft_size, nullptr, ap.data());

    return cache;
}

// ============================================================
// get_or_analyze
// ============================================================

std::shared_ptr<const AnalysisCache>
get_or_analyze(std::shared_ptr<const EmbeddedVoice> ev_sp, int fft_size, int spec_bins)
{
    if (!ev_sp) return nullptr;
    const std::string& key = ev_sp->path;

    // 1. メモリキャッシュをチェック（CacheStore 内部でロック）
    {
        auto cached = g_analysis_cache.get(key);
        if (cached) return cached;
    }

    // 2. ディスクキャッシュ読み込み（ロック外）
    const std::string cache_file = get_cache_dir() + "/" + generate_cache_hash(key) + ".vsc";
    auto disk_cache = load_cache(cache_file, spec_bins);
    if (disk_cache) {
        g_analysis_cache.put(key, disk_cache);
        return disk_cache;
    }

    // 3. 新規解析（ロック外、重い処理）
    auto cache = build_analysis_cache(*ev_sp, fft_size, spec_bins);

    // 4. メモリキャッシュに書き込み
    g_analysis_cache.put(key, cache);
    save_cache(cache_file, *cache);  // ディスク保存（ロック外でOK）
    return cache;
}
// ============================================================
// UTAUタイムマッピング
// ============================================================

double get_source_ms(const EmbeddedVoice& ev) {
    return static_cast<double>(ev.waveform.size()) / ev.fs * 1000.0;
}

double map_time(double t_out_ms, const OtoEntry& oto,
                        double source_wav_len_ms, double note_duration_ms)
{
    const double offset     = oto.offset;
    const double fixed      = oto.consonant;
    const double cutoff_pos = (oto.cutoff < 0)
                              ? source_wav_len_ms + oto.cutoff : oto.cutoff;
    const double source_stretch = cutoff_pos - (offset + fixed);
    const double output_stretch = note_duration_ms - fixed;
    if (t_out_ms < fixed) return t_out_ms + offset;
    const double ratio = source_stretch / std::max(1.0, output_stretch);
    return (t_out_ms - fixed) * ratio + (offset + fixed);
}

// ============================================================
// copy_cache_to_scratch
// ============================================================

static void copy_cache_to_scratch_cur(const AnalysisCache& c)
{
    tl_scratch.ensure_spec(c.length, c.spec_bins);
    const size_t total = static_cast<size_t>(c.length) * c.spec_bins;
    std::copy(c.flat_spec.begin(), c.flat_spec.begin()+total, tl_scratch.flat_spec.begin());
    std::copy(c.flat_ap  .begin(), c.flat_ap  .begin()+total, tl_scratch.flat_ap  .begin());
    tl_scratch.ensure_f0(c.length);
    std::copy(c.f0  .begin(), c.f0  .begin()+c.length, tl_scratch.f0       .begin());
    std::copy(c.time.begin(), c.time.begin()+c.length, tl_scratch.time_axis.begin());
}

static void copy_cache_to_scratch_prev(const AnalysisCache& c)
{
    tl_scratch.ensure_spec(c.length, c.spec_bins);
    const size_t total = static_cast<size_t>(c.length) * c.spec_bins;
    std::copy(c.flat_spec.begin(), c.flat_spec.begin()+total, tl_scratch.flat_spec_prev.begin());
    std::copy(c.flat_ap  .begin(), c.flat_ap  .begin()+total, tl_scratch.flat_ap_prev  .begin());
    tl_scratch.ensure_f0_prev(c.length);
    std::copy(c.f0  .begin(), c.f0  .begin()+c.length, tl_scratch.f0_prev       .begin());
    std::copy(c.time.begin(), c.time.begin()+c.length, tl_scratch.time_axis_prev.begin());
}

// ============================================================
// resample_curve
// ============================================================

inline double resample_curve(const double* curve, int src_len,
                                     int dst_idx, int dst_len)
{
    if (!curve || src_len <= 0 || dst_len <= 0) return 0.0;
    if (dst_idx < 0) return curve[0];
    if (src_len == 1) return curve[0];
    const double t     = static_cast<double>(dst_idx) / std::max(dst_len-1, 1);
    const double src_f = t * (src_len-1);
    const int    j0    = static_cast<int>(src_f);
    const int    j1    = std::min(j0+1, src_len-1);
    return (1.0-(src_f-j0))*curve[j0] + (src_f-j0)*curve[j1];
}

// ============================================================
// apply_crossfade
//
// dst[offset..] に src を書き込む。先頭 xfade_len サンプルは
// dst と src を raised-cosine でブレンドする。
//
// overlap_samples: oto.ini の overlap をサンプル換算した値。
//   src の先頭を overlap 分だけスキップして書き込み開始することで、
//   子音頭がクロスフェードに食われる問題を解消する。
// ============================================================
static void apply_crossfade(std::vector<double>& dst, int64_t dst_size,
                             const std::vector<double>& src, int64_t src_size,
                             int64_t offset, int xfade_len,
                             int64_t overlap_samples = 0)
{
    if (offset < 0 || offset >= dst_size) return;

    // overlap 分だけ src の読み出し開始位置をずらす
    const int64_t src_start   = clamp(overlap_samples, int64_t(0), src_size);
    const int64_t src_usable  = src_size - src_start;
    if (src_usable <= 0) return;

    const int safe_xfade = static_cast<int>(
        std::min<int64_t>(xfade_len, std::min(src_usable, dst_size - offset)));

    for (int s = 0; s < safe_xfade; ++s) {
        const double  t       = static_cast<double>(s) / safe_xfade;
        const double  fade_in = 0.5 * (1.0 - std::cos(M_PI * t));
        const int64_t di      = offset + s;
        if (di >= dst_size) break;
        dst[di] = dst[di] * (1.0 - fade_in) + src[src_start + s] * fade_in;
    }

    const int64_t body_end = std::min(offset + src_usable, dst_size);
    for (int64_t s = offset + safe_xfade; s < body_end; ++s)
        dst[s] = src[src_start + (s - offset)];
}

// ============================================================
// apply_gender_shift  （フォルマント追従付き高音域補正）
//
// gender  ∈ [0.0, 1.0]  0.5=変更なし / <0.5=太い声 / >0.5=細い声
// f0_ratio: 現在フレームのF0 / 音源基準F0
//   高音域ほど > 1.0 → スペクトル包絡を引き伸ばしてフォルマントを追従させる
//   UTAUの標準resamplerは高音でスペクトルをそのまま使うため「こもる」。
//   ここでF0比に応じて引き伸ばすことで自然な声質を維持する。
// ============================================================

void apply_gender_shift(double* sr, int spec_bins, double gender,
                        double* tmp, double f0_ratio)
{
    if (!sr || !tmp || spec_bins <= 0) return;

    // gender シフト比 + F0 追従補正を合成
    const double gender_ratio = std::exp((gender - 0.5) * 0.4 * std::log(2.0));

    // 高音域補正: F0 が上がるほどスペクトルを引き伸ばす
    // 補正量は F0 比の 0.5 乗（完全追従は 1.0 乗だが過補正になるので 0.5 が自然）
    const double formant_ratio = (f0_ratio > 0.0)
        ? std::pow(f0_ratio, 0.5) : 1.0;

    const double shift_ratio = gender_ratio * formant_ratio;

    // gender も formant も変化なし → 処理スキップ
    if (std::abs(shift_ratio - 1.0) < 1e-4) return;

    constexpr double kFloor = 1e-12;
    for (int k = 0; k < spec_bins; ++k)
        tmp[k] = std::log(std::max(sr[k], kFloor));

    for (int k = 0; k < spec_bins; ++k) {
        const double src_k = static_cast<double>(k) / shift_ratio;
        const int    k0    = static_cast<int>(src_k);
        if (k0 >= spec_bins - 1) {
            sr[k] = std::exp(tmp[spec_bins - 1]);
        } else {
            const double frac = src_k - k0;
            sr[k] = std::exp((1.0 - frac) * tmp[k0] + frac * tmp[k0 + 1]);
        }
    }
}

// ============================================================
// apply_tension_breath
// ============================================================

void apply_tension_breath(double* sr, double* ar, int spec_bins,
                                  double tension, double breath)
{
    if (!sr || !ar || spec_bins <= 1) return;
    const double inv = 1.0 / (spec_bins-1);
    for (int k = 0; k < spec_bins; ++k) {
        const double fw = static_cast<double>(k) * inv;
        if (std::abs(tension-0.5) > 1e-4) {
            const double weight     = 1.0/(1.0+std::exp(-8.0*(fw-0.35)));
            const double gain_db    = (tension-0.5)*12.0*weight;
            const double clipped_db = 6.0*std::tanh(gain_db/6.0);
            sr[k] *= std::pow(10.0, clipped_db/20.0);
        }
        if (std::abs(breath-0.5) > 1e-4) {
            const double bw     = std::pow(fw, 0.7);
            const double amount = (breath-0.5)*bw;
            ar[k] = amount >= 0.0
                ? ar[k] + amount*(1.0-ar[k])
                : ar[k] + amount*ar[k];
            ar[k] = clamp(ar[k], 0.0, 1.0);
        }
    }
}

// ============================================================
// blend_transition_spectra
// ============================================================

void blend_transition_spectra(
    double** spec_cur, double** ap_cur, int cur_len,
    double** spec_prev, double** ap_prev, int prev_len,
    int spec_bins, int transition_frames)
{
    if (!spec_cur || !spec_prev || !ap_cur || !ap_prev) return;
    if (spec_bins <= 0 || cur_len <= 0 || prev_len <= 0) return;
    const int blend = std::min(transition_frames, std::min(cur_len, prev_len));
    for (int j = 0; j < blend; ++j) {
        const double t      = static_cast<double>(j) / blend;
        const double w_prev = 0.5*(1.0-std::cos(M_PI*(1.0-t)));
        const double w_cur  = 1.0 - w_prev;
        const int    prev_j = prev_len - blend + j;
        constexpr double kFloor = 1e-12;
        double* sc = spec_cur [j];
        double* sp = spec_prev[std::max(0, prev_j)];
        double* ac = ap_cur   [j];
        double* ap = ap_prev  [std::max(0, prev_j)];
        for (int k = 0; k < spec_bins; ++k) {
            sc[k] = std::exp(w_cur *std::log(std::max(sc[k],kFloor))
                           + w_prev*std::log(std::max(sp[k],kFloor)));
            ac[k] = clamp(w_cur*ac[k] + w_prev*ap[k], 0.0, 1.0);
        }
    }
}

// ============================================================
// apply_vibrato
//
// ノート後半50%からビブラートを自然に立ち上げる。
// global_time_offset_sec: 曲先頭からの絶対時間 → ノートをまたいで位相連続
// depth_curve/rate_curve: ノートごとの制御カーブ（nullptr = デフォルト）
// ============================================================
void apply_vibrato(double* f0, int f0_length, double frame_period_ms,
                   double global_time_offset_sec,
                   const double* depth_curve,  // nullptr = 全フレーム 1.0
                   const double* rate_curve,   // nullptr = 全フレーム 6.0Hz
                   int curve_length)
{
    if (!f0 || f0_length <= 0) return;

    const int vib_start = f0_length / 2;
    const int vib_len   = f0_length - vib_start;
    if (vib_len <= 0) return;

    constexpr double kVibDepthMax = 0.00868;  // 15cent
    constexpr double kVibFreqDef  = 6.0;
    const double     frame_sec    = frame_period_ms / 1000.0;

    for (int j = vib_start; j < f0_length; ++j) {
        const double fade_progress =
            static_cast<double>(j - vib_start) / std::max(vib_len - 1, 1);
        const double fade_in = std::min(fade_progress * 4.0, 1.0);

        // カーブをリサンプリング（curve_length != f0_length でも対応）
        const double depth = depth_curve
            ? resample_curve(depth_curve, curve_length, j, f0_length)
            : 1.0;
        const double rate  = rate_curve
            ? std::max(1.0, resample_curve(rate_curve, curve_length, j, f0_length))
            : kVibFreqDef;

        const double t_global = global_time_offset_sec
                                + static_cast<double>(j) * frame_sec;
        const double vib = std::sin(2.0 * M_PI * rate * t_global)
                           * kVibDepthMax * depth * f0[j] * fade_in;
        f0[j] = std::max(50.0, f0[j] + vib);
    }
}

// ============================================================
// [NEW ③] smooth_f0_gaussian
//
// F0配列にガウシアンカーネルを畳み込んで音符境界の急変を緩和する。
// カーネル幅: 5フレーム（= 25ms @ 5ms/frame）
// 端点は折り返しパディングで処理する（ゼロパディングより自然）。
//
// 処理コスト: f0_length × 5 の乗算のみ → 無視できる
// ============================================================

void smooth_f0_gaussian(double* f0, int f0_length)
{
    if (!f0 || f0_length <= 0) return;

    // sigma=1.0 の5点ガウシアンカーネル（正規化済み）
    static constexpr double kKernel[5] = {
        0.06136, 0.24477, 0.38774, 0.24477, 0.06136
    };
    static constexpr int kRadius = 2; // カーネル半径

    std::vector<double> tmp(f0_length);
    for (int i = 0; i < f0_length; ++i) {
        double sum = 0.0;
        for (int k = -kRadius; k <= kRadius; ++k) {
            // 折り返しパディング: 端点を反射させる
            int idx = i + k;
            if (idx < 0)           idx = -idx;
            if (idx >= f0_length)  idx = 2*(f0_length-1) - idx;
            sum += f0[idx] * kKernel[k + kRadius];
        }
        tmp[i] = sum;
    }
    std::copy(tmp.begin(), tmp.end(), f0);
}

// ============================================================
// VOSE_Synthesis
// ============================================================

static void VOSE_Synthesis(
    const double* f0, int f0_length,
    double** spectrogram, double** aperiodicity,
    int fft_size, double frame_period, int fs,
    int y_length, double* y)
{
    const int spec_bins = fft_size / 2 + 1;
    tl_scratch.ensure_spec(f0_length, spec_bins);
    double** mod_ap = tl_scratch.mod_ap_ptrs.data();

    static thread_local std::mt19937 rng(
        std::random_device{}() ^
        static_cast<uint32_t>(std::hash<std::thread::id>{}(
            std::this_thread::get_id())));
    std::uniform_real_distribution<double> dist(-0.02, 0.02);

    for (int i = 0; i < f0_length; ++i) {
        double* ap_dst = mod_ap[i];
        double* ap_src = aperiodicity[i];
        double delta_f0 = 0.0;
        if (i > 0 && i < f0_length-1)
            delta_f0 = std::abs(f0[i+1]-f0[i-1])*0.5;
        const double vibrato_breath = std::min(0.15, delta_f0*0.003);
        for (int k = 0; k < spec_bins; ++k) {
            double current_ap = ap_src[k];
            const double freq = static_cast<double>(k)*fs/fft_size;
            if (freq > 2000.0) current_ap += vibrato_breath + dist(rng);
            ap_dst[k] = clamp(current_ap, 0.0, 1.0);
        }
    }

    Synthesis(f0, f0_length, spectrogram, mod_ap,
              fft_size, frame_period, fs, y_length, y);

    double prev_x = 0.0, prev_y_hp = 0.0;
    for (int i = 0; i < y_length; ++i) {
        double hp = y[i] - prev_x + 0.85*prev_y_hp;
        prev_x = y[i];
        prev_y_hp = hp;
        y[i] += hp*0.05;
    }
}

// ============================================================
// apply_post_eq
//
// WORLD合成出力に対する Biquad IIR ポストEQフィルタ。
//
// 補正対象:
//   80Hz   -1.5dB  低域の位相歪みを軽減（low shelf）
//   380Hz  -2.0dB  CheapTrickによる箱鳴り感をカット
//   3kHz   -2.5dB  金属的・機械的な倍音ピークをカット
//   6kHz   +1.5dB  プレゼンス（声の前への出方）を補強
//   9kHz   +2.5dB  エアー感・息の質感を付加（high shelf）
//   14kHz  +1.5dB  超高域の空気感を補強（high shelf）
//
// 実装:
//   直列 Biquad IIR（Audio EQ Cookbook, Zölzer準拠）
//   44100Hz 固定係数。各バンド {b0, b1, b2, a1, a2}
//   処理コスト: 6バンド × 5乗算 = 30演算/sample
//
// 周波数応答（全バンド合成）:
//    100Hz: -0.59dB   380Hz: -2.04dB   1kHz: -0.22dB
//    3kHz:  -2.15dB   6kHz:  +1.69dB   9kHz: +1.93dB
//   14kHz:  +3.16dB  20kHz:  +3.98dB
// ============================================================

static const double kPostEQ[6][5] = {
    //  b0               b1               b2               a1               a2
    {  0.9991702401, -1.9799444128,  0.9808921526, -1.9799332931,  0.9800735124 }, // 80Hz  -1.5dB low shelf
    {  0.9959199627, -1.9574523909,  0.9644048069, -1.9574523909,  0.9603247695 }, // 380Hz -2.0dB peaking
    {  0.9732681116, -1.6255368854,  0.8129672385, -1.6255368854,  0.7862353501 }, // 3kHz  -2.5dB peaking
    {  1.0421903920, -1.0188582642,  0.5101714814, -1.0188582642,  0.5523618733 }, // 6kHz  +1.5dB peaking
    {  1.1826694018, -0.4862449515,  0.2096969549, -0.2513191682,  0.1574405734 }, // 9kHz  +2.5dB high shelf
    {  1.0679214447,  0.4618551642,  0.1643779455,  0.5229532628,  0.1712012916 }, // 14kHz +1.5dB high shelf
};

static void apply_post_eq(double* y, int y_length)
{
    if (!y || y_length <= 0) return;

    // 各バンドのフィルタ状態（x: 入力2サンプル前、y: 出力2サンプル前）
    // Direct Form II Transposed で実装（数値安定性が高い）
    struct BiquadState { double s1 = 0.0, s2 = 0.0; };
    BiquadState states[6];

    for (int i = 0; i < y_length; ++i) {
        double x = y[i];
        for (int b = 0; b < 6; ++b) {
            const double* c = kPostEQ[b];
            // Direct Form II Transposed:
            //   y[n] = b0*x[n] + s1[n-1]
            //   s1[n] = b1*x[n] - a1*y[n] + s2[n-1]
            //   s2[n] = b2*x[n] - a2*y[n]
            const double out = c[0]*x + states[b].s1;
            states[b].s1     = c[1]*x - c[3]*out + states[b].s2;
            states[b].s2     = c[2]*x - c[4]*out;
            x = out;
        }
        y[i] = x;
    }
}

// execute_render の並列合成ラムダを自由関数に昇格。
// vose_streaming.cpp の synth_loop() からも呼べる。
// ============================================================

struct SynthNoteParams {
    const NotePrepass& pp;
    NoteEvent&         n;
    int                fft_size;
    int                spec_bins;
    double             global_time_sec = 0.0;  // 曲先頭からのオフセット（ビブラート位相連続化）
};

static const OtoEntry kDefaultOto = {};

void synthesize_note_impl(const SynthNoteParams& p, std::vector<double>& note_buf)
{
    const NotePrepass& pp    = p.pp;
    NoteEvent&         n     = p.n;
    const int   fft_size     = p.fft_size;
    const int   spec_bins    = p.spec_bins;

    if (pp.state != NoteState::RENDERABLE) return;

    const int64_t note_samples  = pp.note_samples;
    const double  note_ms       = static_cast<double>(note_samples) / kFs * 1000.0;
    const double  src_ms        = get_source_ms(*pp.ev);
    const int     output_frames = static_cast<int>(note_ms / kFramePeriod);
    const OtoEntry& current_oto = pp.has_oto ? pp.oto : kDefaultOto;

    auto cache_cur = get_or_analyze(pp.ev, fft_size, spec_bins);

    // フォルマント追従用: 音源の基準F0（解析時の有声フレーム平均）を計算
    // これを各フレームのF0と比較してスペクトルの引き伸ばし量を決める
    double base_f0 = 0.0;
    {
        int voiced = 0;
        for (int j = 0; j < cache_cur->length; ++j) {
            if (cache_cur->f0[j] > 50.0) { base_f0 += cache_cur->f0[j]; ++voiced; }
        }
        base_f0 = (voiced > 0) ? base_f0 / voiced : 220.0;
    }

    tl_scratch.ensure_f0(output_frames);
    tl_scratch.ensure_spec(output_frames, spec_bins);

    // ----------------------------------------------------------------
    // ステップ1: cur スペクトルを DSP 込みで書き込む
    // (blend_transition_spectra より先に実行する必要がある)
    // ----------------------------------------------------------------
    for (int j = 0; j < output_frames; ++j) {
        const double t_out_ms = j * kFramePeriod;
        const double t_src_ms = map_time(t_out_ms, current_oto, src_ms, note_ms);
        const int src_frame   = clamp(
            static_cast<int>(t_src_ms / kFramePeriod), 0, cache_cur->length - 1);

        double* sr = tl_scratch.spec_ptrs[j];
        double* ar = tl_scratch.ap_ptrs[j];
        std::copy_n(&cache_cur->flat_spec[static_cast<size_t>(src_frame) * spec_bins],
                    spec_bins, sr);
        std::copy_n(&cache_cur->flat_ap[static_cast<size_t>(src_frame) * spec_bins],
                    spec_bins, ar);

        // ---- 1. ベースF0を計算 ----
        double base_f0_val = n.pitch_curve
            ? resample_curve(n.pitch_curve, n.pitch_length, j, output_frames)
            : 440.0;

        // ---- 2. ★★★ ポルタメントオフセットを適用（セント → Hz） ★★★ ----
        if (n.portamento_offsets && n.portamento_length > 0 && j < n.portamento_length) {
            double cents = resample_curve(n.portamento_offsets, n.portamento_length, j, output_frames);
            base_f0_val *= std::pow(2.0, cents / 1200.0);
        }

        tl_scratch.f0[j] = base_f0_val;   // ← ここで確定

        // ---- 3. その他のパラメータ ----
        const double gender  = n.gender_curve
            ? resample_curve(n.gender_curve,  n.pitch_length, j, output_frames) : 0.5;
        const double tension = n.tension_curve
            ? resample_curve(n.tension_curve, n.pitch_length, j, output_frames) : 0.5;
        const double breath  = n.breath_curve
            ? resample_curve(n.breath_curve,  n.pitch_length, j, output_frames) : 0.5;

        // ---- 4. フォルマント追従（ポルタメント適用後のF0を使用） ----
        const double f0_ratio = (base_f0 > 0.0) ? tl_scratch.f0[j] / base_f0 : 1.0;
        apply_gender_shift(sr, spec_bins, gender, tl_scratch.spec_tmp.data(), f0_ratio);
        apply_tension_breath(sr, ar, spec_bins, tension, breath);
    }
    // ----------------------------------------------------------------
    // ステップ2: prev スペクトルを scratch_prev に展開してブレンド
    // (cur が書き終わった後でないと blend の cur 側がゼロになる)
    // ----------------------------------------------------------------
    if (pp.prev_ev) {
        auto cache_prev = get_or_analyze(pp.prev_ev, fft_size, spec_bins);
        copy_cache_to_scratch_prev(*cache_prev);
        blend_transition_spectra(
            tl_scratch.spec_ptrs.data(), tl_scratch.ap_ptrs.data(), output_frames,
            tl_scratch.spec_ptrs_prev.data(), tl_scratch.ap_ptrs_prev.data(),
            cache_prev->length, spec_bins, kTransitionFrames);
    }

    smooth_f0_gaussian(tl_scratch.f0.data(), output_frames);

    // ビブラートカーブが NoteEvent にあれば使用、なければデフォルト (depth=1.0, rate=6Hz)
    // NoteEvent 側に vibrato_depth_curve / vibrato_rate_curve / vibrato_curve_length
    // フィールドを追加した場合はそのまま渡せる。未定義なら nullptr で問題ない。
    const double* vib_depth = (n.vibrato_depth_curve && n.vibrato_curve_length > 0)
                              ? n.vibrato_depth_curve : nullptr;
    const double* vib_rate  = (n.vibrato_rate_curve  && n.vibrato_curve_length > 0)
                              ? n.vibrato_rate_curve  : nullptr;
    const int     vib_clen  = n.vibrato_curve_length > 0 ? n.vibrato_curve_length : 0;

    apply_vibrato(tl_scratch.f0.data(), output_frames, kFramePeriod,
                  p.global_time_sec, vib_depth, vib_rate, vib_clen);

    note_buf.assign(static_cast<size_t>(note_samples), 0.0);
    VOSE_Synthesis(tl_scratch.f0.data(), output_frames,
                   tl_scratch.spec_ptrs.data(), tl_scratch.ap_ptrs.data(),
                   fft_size, kFramePeriod, pp.ev->fs,
                   static_cast<int>(note_samples), note_buf.data());

    // ポストEQ: WORLD出力の金属的倍音・箱鳴り補正、高域補強
    apply_post_eq(note_buf.data(), static_cast<int>(note_samples));
}

// ============================================================
// レンダリング進捗・キャンセル用コールバック
//
// Python(ctypes)側からは CFUNCTYPE(None, c_int) / CFUNCTYPE(c_int) として
// 渡す想定。呼び出し規約はプラットフォームデフォルト（ctypes標準）。
//   ProgressCallback:   進捗率(0-100)を通知する。nullptr可（呼ばれない）。
//   CancelCheckCallback: 非0を返すとレンダリングを中断する。nullptr可。
// ============================================================
typedef void (*ProgressCallback)(int percent);
typedef int  (*CancelCheckCallback)();

// ============================================================
// extern "C" API
// ============================================================

extern "C" {

void init_official_engine() { register_all_embedded_voices(); }

DLLEXPORT void load_embedded_resource(const char* phoneme,
                                      const int16_t* raw_data, int sample_count)
{
    if (!phoneme || !raw_data || sample_count <= 0) return;

    auto ev = std::make_shared<EmbeddedVoice>();
    ev->fs = kFs;
    ev->waveform.resize(sample_count);
    for (int i = 0; i < sample_count; ++i)
        ev->waveform[i] = static_cast<double>(raw_data[i]) * kInv32768;

    VoseUniqueLock clock(g_analysis_cache_mutex);
    VoseUniqueLock wlock(g_voice_db_mutex);
    // パス文字列キーでキャッシュを無効化（再ロード時も確実にヒット）
    g_analysis_cache.erase(phoneme);
    ev->path = phoneme;
    g_voice_db[phoneme] = std::move(ev);
}

// ============================================================
// execute_render  (並列合成版)
//
// 並列化の設計:
//   パス2を「合成フェーズ」と「書き込みフェーズ」に分離する。
//
//   [合成フェーズ・並列]
//     各ノートの note_buf を std::async で独立して合成する。
//     ノード間の依存関係（current_offset, full_song_buffer）には
//     一切触れないので安全に並列化できる。
//     tl_scratch は thread_local なのでスレッドごとに独立している。
//
//   [書き込みフェーズ・順次]
//     future.get() で合成完了を待ち、apply_crossfade でシングルスレッドで書き込む。
//     full_song_buffer への書き込みはここだけなのでデータ競合なし。
//
// スレッド数:
//   std::thread::hardware_concurrency() を上限とするが、
//   音源の解析（get_or_analyze）は g_analysis_cache_mutex を取るため
//   キャッシュミス時だけ直列化される。通常はキャッシュヒットするので問題なし。
// ============================================================
 

static void execute_render_impl(NoteEvent* notes, int note_count, const char* output_path,
                                 int mode_flag,
                                 ProgressCallback progress_cb,
                                 CancelCheckCallback cancel_cb)
{
    auto report_progress = [&](int pct) {
        if (progress_cb) progress_cb(pct);
    };
    auto is_cancelled = [&]() -> bool {
        return cancel_cb && cancel_cb() != 0;
    };

    if (!notes || note_count <= 0 || !output_path) return;
    if (is_cancelled()) return;

    // ================================================================
    // Pro版（Studio Master）の判定とパラメータ設定
    // ================================================================
    bool is_pro = (mode_flag == 1);
    
    // Pro版は 32bit float (または32bit PCM)、無料版は 16bit CD音質
    int out_bit_depth = is_pro ? 32 : 16;
    
    // ※将来的に96kHz出力を行う場合は、ここの out_fs を切り替えて、
    // 最後の wavwrite 前にリサンプリング処理を挟みます。
    int out_fs = kFs; 

    const int fft_size  = GetFFTSizeForCheapTrick(kFs, nullptr);
    const int spec_bins = fft_size / 2 + 1;

    // ----------------------------------------------------------------
    // パス1: NotePrepass 構築（変更なし）
    // ----------------------------------------------------------------
    std::vector<NotePrepass> prepass(note_count);
    int     max_harvest_len  = 0;
    int64_t total_samples    = 0;
    int     xfade_count      = 0;
    bool    prev_renderable  = false;
    double  max_preutterance = 0.0;
    std::shared_ptr<const EmbeddedVoice> last_ev;

    for (int i = 0; i < note_count; ++i) {
        const int pitch_len = notes[i].pitch_length;
        if (pitch_len <= 0 || pitch_len > kMaxPitchLength) {
            prepass[i]      = NotePrepass(NoteState::INVALID, 0, nullptr);
            prev_renderable = false;
            last_ev         = nullptr;
            continue;
        }

        const int64_t ns = note_samples_safe(pitch_len);
        if (!notes[i].wav_path) {
            prepass[i]      = NotePrepass(NoteState::NO_VOICE, ns, nullptr);
            prev_renderable = false;
            last_ev         = nullptr;
            total_samples  += ns;
            continue;
        }
        auto ev = find_voice_ref(notes[i].wav_path);

        const OtoEntry* found_oto = nullptr;
        {
            VoseUniqueLock lock(g_oto_db_mutex);
            auto oto_it = g_oto_db.find(notes[i].wav_path);
            if (oto_it != g_oto_db.end()) {
                found_oto = &oto_it->second;
                max_preutterance = std::max(max_preutterance,
                                            found_oto->preutterance);
            }
        }

        if (ev) {
            prepass[i] = NotePrepass(NoteState::RENDERABLE, ns, ev,
                                     prev_renderable ? last_ev : nullptr,
                                     found_oto);
            if (prev_renderable) ++xfade_count;
            prev_renderable = true;
            last_ev         = ev;
            const int wav_len     = static_cast<int>(ev->waveform.size());
            const int harvest_len = GetSamplesForHarvest(ev->fs, wav_len, kFramePeriod);
            if (harvest_len > max_harvest_len) max_harvest_len = harvest_len;
        } else {
            prepass[i]      = NotePrepass(NoteState::NO_VOICE, ns, nullptr);
            prev_renderable = false;
            last_ev         = nullptr;
        }
        total_samples += ns;
    }

    total_samples -= static_cast<int64_t>(kCrossfadeSamples) * xfade_count;
    if (total_samples <= 0) return;

    report_progress(2);
    if (is_cancelled()) return;

    const int64_t pre_buffer_samples =
        static_cast<int64_t>(max_preutterance * kFs / 1000.0);
    const int64_t buffer_total = total_samples + pre_buffer_samples;

    tl_scratch.ensure_spec(max_harvest_len, spec_bins);
    std::vector<double> full_song_buffer(buffer_total, 0.0);

    // ----------------------------------------------------------------
    // パス2-A: 各ノートの note_buf を並列合成
    //
    // 設計上の注意:
    //   tl_scratch は thread_local なので「スレッドごとに独立」だが、
    //   std::async(launch::async) は実装によってスレッドプールを再利用する。
    //   同じスレッドが2ノード分の synthesize_note_impl を
    //   ネストして呼び出すことはないが、プールの枯渇で
    //   launch::deferred（= メインスレッドで実行）に fallback する実装もある。
    //   安全のため、1ノート = 1スレッドを明示的に生成する方式にする。
    //   スレッド数は hardware_concurrency でキャップし、バッチ処理する。
    // ----------------------------------------------------------------
    const int max_threads = static_cast<int>(
        std::max(1u, std::thread::hardware_concurrency()));

    std::vector<std::vector<double>> note_bufs(note_count);

    // RENDERABLE なノートのインデックスだけ集める
    std::vector<int> renderable_indices;
    renderable_indices.reserve(note_count);
    for (int i = 0; i < note_count; ++i)
        if (prepass[i].state == NoteState::RENDERABLE)
            renderable_indices.push_back(i);

    // ノートごとのグローバル時間オフセット（ビブラート位相連続化用）
    std::vector<double> note_global_time(note_count, 0.0);
    {
        double acc_sec = 0.0;
        for (int i = 0; i < note_count; ++i) {
            note_global_time[i] = acc_sec;
            if (prepass[i].note_samples > 0)
                acc_sec += static_cast<double>(prepass[i].note_samples) / kFs;
        }
    }

    // max_threads ずつバッチ処理
    // 各スレッドは独立した tl_scratch（thread_local）を持つため競合しない
    //
    // 進捗・キャンセルについて:
    //   このバッチループが全体の処理時間の大半（合成フェーズ）を占めるため、
    //   ここでバッチ単位に進捗を通知し、キャンセル要求もここでチェックする。
    //   進捗レンジは 2%〜80% を合成フェーズに割り当てる
    //   （0-2%: 準備, 80-95%: 書き込み/後処理, 95-100%: wavwrite）。
    const int total_renderable = static_cast<int>(renderable_indices.size());
    bool cancelled_during_synth = false;

    for (int batch_start = 0;
         batch_start < total_renderable;
         batch_start += max_threads)
    {
        if (is_cancelled()) { cancelled_during_synth = true; break; }

        const int batch_end = std::min(
            batch_start + max_threads,
            total_renderable);

        std::vector<std::thread> threads;
        threads.reserve(batch_end - batch_start);

        for (int bi = batch_start; bi < batch_end; ++bi) {
            const int idx = renderable_indices[bi];
            threads.emplace_back([&, idx] {
                SynthNoteParams p{ prepass[idx], notes[idx], fft_size, spec_bins,
                                   note_global_time[idx] };
                synthesize_note_impl(p, note_bufs[idx]);
            });
        }
        for (auto& t : threads) t.join();

        if (total_renderable > 0) {
            const int pct = 2 + static_cast<int>(
                (static_cast<double>(batch_end) / total_renderable) * 78.0);
            report_progress(std::min(pct, 80));
        }
    }

    if (cancelled_during_synth || is_cancelled()) return;

    // ----------------------------------------------------------------
    // パス2-B: 書き込みフェーズ
    // ----------------------------------------------------------------
    int64_t current_offset     = pre_buffer_samples;
    bool    last_note_rendered = false;
    for (int idx = 0; idx < note_count; ++idx) {
        const NotePrepass& pp = prepass[idx];
        switch (pp.state) {
        case NoteState::INVALID:
        case NoteState::NO_VOICE:
            last_note_rendered = false;
            if (pp.state == NoteState::NO_VOICE) current_offset += pp.note_samples;
            continue;
        case NoteState::RENDERABLE:
            break;
        }
        const int64_t note_samples = pp.note_samples;
        const OtoEntry& current_oto = pp.has_oto ? pp.oto : kDefaultOto;
        const int64_t pre_samples     =
            static_cast<int64_t>(current_oto.preutterance * kFs / 1000.0);
        // overlap: oto.ini の overlap フィールドが存在する場合に有効。
        // vose_core.h の OtoEntry に overlap メンバがなければ 0 に変更すること。
        // (UTAUの標準的な OtoEntry には overlap が存在する)
        const int64_t overlap_samples =
            static_cast<int64_t>(current_oto.overlap * kFs / 1000.0);
        const int64_t base_offset  = last_note_rendered
                                     ? current_offset - kCrossfadeSamples
                                     : current_offset;
        const int64_t write_offset = std::max<int64_t>(0, base_offset - pre_samples);

        // [FIX] 実際にどれだけ前方へ後退したか（= 本当にブレンドすべき幅）を計算する。
        //       preutteranceが長い音素ほど後退量が増えるので、xfadeもそれに追従させる。
        //       note_samplesを超えないようクランプ（apply_crossfade側の安全策と二重に保護）。
        const int64_t actual_overlap = last_note_rendered
                                       ? (current_offset - write_offset)
                                       : 0;
        const int     xfade = last_note_rendered
                             ? static_cast<int>(std::min<int64_t>(actual_overlap, note_samples))
                             : 0;

        apply_crossfade(full_song_buffer, buffer_total,
                        note_bufs[idx], note_samples,
                        write_offset, xfade, overlap_samples);
        current_offset += last_note_rendered
                          ? note_samples - kCrossfadeSamples
                          : note_samples;
        last_note_rendered = true;
    }
    report_progress(85);
    if (is_cancelled()) return;

    // ----------------------------------------------------------------
    // BigVGAN ボコーダー処理
    //
    // WORLD合成の出力PCM（double[]）をメルスペクトログラムに変換し、
    // BigVGAN ONNX モデルで高品質PCMに再合成する。
    //
    // パイプライン:
    //   full_song_buffer (WORLD出力, double[])
    //     → pcm_float (float[], [-1,1] 正規化)
    //     → mel_filterbank (128bin, win=2048, hop=512, 44100Hz)
    //     → BigVGAN推論 (128フレームchunk, 25msオーバーラップ)
    //     → overlap-add → wavwrite
    //
    // ※ models/bigvgan/bigvgan_generator.onnx / bigvgan/config.json の
    //   実仕様に合わせたパラメータ（旧: 80bin/1024fft/256hopから変更）。
    //   入出力テンソル名も実モデルに合わせて "mel" / "audio"。
    //
    // BigVGANが無効なら従来通り WORLD出力をそのまま wavwrite する。
    // ----------------------------------------------------------------
{
        const double* src   = full_song_buffer.data() + pre_buffer_samples;
        const int     n_src = static_cast<int>(total_samples);

#ifdef VOSE_PRO
        if (g_bigvgan_session && n_src > 0) {
            // ----------------------------------------------------------
            // ステップ1: double → float 正規化
            // ----------------------------------------------------------
            std::vector<float> pcm(n_src);
            for (int i = 0; i < n_src; ++i)
                pcm[i] = static_cast<float>(std::clamp(src[i], -1.0, 1.0));

            // ----------------------------------------------------------
            // ステップ2: メルスペクトログラム変換
            //
            // パラメータ (bigvgan/config.json の実値に一致させる):
            //   sample_rate = 44100
            //   n_fft       = 2048
            //   win_size    = 2048
            //   hop_size    = 512
            //   n_mels      = 128
            //   fmin        = 0 Hz
            //   fmax        = 22050 Hz (Nyquist, config.json では null)
            //
            // 振幅(magnitude)スペクトルを使用（torch.stft → sqrt(re²+im²)相当）。
            // パワースペクトル(re²+im²のみ)ではBigVGAN学習時の分布とズレるため誤り。
            // フレーム境界は reflect-padding（torch.stft(center=True)と同じ挙動）。
            // ----------------------------------------------------------
            constexpr int   kNFft    = 2048;
            constexpr int   kHop     = 512;
            constexpr int   kNMels   = 128;
            constexpr float kFMin    = 0.0f;
            constexpr float kFMax    = 22050.0f;
            constexpr float kSR      = 44100.0f;
            constexpr float kLogFloor = 1e-5f;  // log(mel) のフロア

            const int n_frames = (n_src + kHop - 1) / kHop;

            // Hann窓
            std::vector<float> window(kNFft);
            for (int i = 0; i < kNFft; ++i)
                window[i] = 0.5f * (1.0f - std::cos(2.0f * static_cast<float>(M_PI) * i / kNFft));

            // メルフィルタバンク行列を構築（n_mels × (n_fft/2+1)）
            // 正規化: 各フィルタをその帯域幅で割る slaney 正規化
            // （librosa.filters.mel のデフォルトと同じ。BigVGAN学習側と一致させる）
            const int spec_bins_fft = kNFft / 2 + 1;
            auto hz_to_mel = [](float hz) { return 2595.0f * std::log10(1.0f + hz / 700.0f); };
            auto mel_to_hz = [](float mel) { return 700.0f * (std::pow(10.0f, mel / 2595.0f) - 1.0f); };

            std::vector<std::vector<float>> mel_fb(kNMels, std::vector<float>(spec_bins_fft, 0.0f));
            {
                const float mel_min = hz_to_mel(kFMin);
                const float mel_max = hz_to_mel(kFMax);
                std::vector<float> mel_pts(kNMels + 2);
                for (int m = 0; m < kNMels + 2; ++m)
                    mel_pts[m] = mel_to_hz(mel_min + (mel_max - mel_min) * m / (kNMels + 1));

                for (int m = 0; m < kNMels; ++m) {
                    const float norm = 2.0f / (mel_pts[m+2] - mel_pts[m]); // 面積正規化
                    for (int k = 0; k < spec_bins_fft; ++k) {
                        const float hz = k * kSR / kNFft;
                        if (hz >= mel_pts[m] && hz <= mel_pts[m+1])
                            mel_fb[m][k] = norm * (hz - mel_pts[m]) / (mel_pts[m+1] - mel_pts[m]);
                        else if (hz > mel_pts[m+1] && hz <= mel_pts[m+2])
                            mel_fb[m][k] = norm * (mel_pts[m+2] - hz) / (mel_pts[m+2] - mel_pts[m+1]);
                    }
                }
            }

            // メルスペクトログラム [n_frames][n_mels]
            std::vector<std::vector<float>> mel_spec(n_frames, std::vector<float>(kNMels, kLogFloor));
            {
                std::vector<float> frame_buf(kNFft, 0.0f);
                std::vector<float> mag(spec_bins_fft);
                std::vector<float> re(kNFft), im(kNFft);

                // reflect-pad で参照するためのヘルパー（torch.stft(center=True, pad_mode="reflect")と同じ）
                auto reflect_sample = [&](int s) -> float {
                    if (n_src <= 1) return (n_src == 1) ? pcm[0] : 0.0f;
                    while (s < 0 || s >= n_src) {
                        if (s < 0)        s = -s;
                        if (s >= n_src)   s = 2 * (n_src - 1) - s;
                    }
                    return pcm[s];
                };

                for (int t = 0; t < n_frames; ++t) {
                    const int center = t * kHop;
                    for (int i = 0; i < kNFft; ++i) {
                        const int s = center - kNFft/2 + i;
                        frame_buf[i] = reflect_sample(s) * window[i];
                    }

                    // Cooley-Tukey 基数2 DIT FFT（正しい順序）
                    // ステップ1: ビット反転並べ替え（これを先にやる）
                    std::copy(frame_buf.begin(), frame_buf.end(), re.begin());
                    std::fill(im.begin(), im.end(), 0.0f);
                    {
                        int j = 0;
                        for (int i = 1; i < kNFft; ++i) {
                            int bit = kNFft >> 1;
                            for (; j & bit; bit >>= 1) j ^= bit;
                            j ^= bit;
                            if (i < j) { std::swap(re[i], re[j]); }
                        }
                    }
                    // ステップ2: バタフライ演算（並べ替え後に実行）
                    for (int step = 1; step < kNFft; step <<= 1) {
                        const float ang_base = -static_cast<float>(M_PI) / step;
                        for (int i = 0; i < kNFft; i += step * 2) {
                            for (int j = 0; j < step; ++j) {
                                const float ang = ang_base * j;
                                const float wr  = std::cos(ang), wi = std::sin(ang);
                                const float tr  = wr*re[i+j+step] - wi*im[i+j+step];
                                const float ti  = wr*im[i+j+step] + wi*re[i+j+step];
                                re[i+j+step] = re[i+j] - tr;
                                im[i+j+step] = im[i+j] - ti;
                                re[i+j]     += tr;
                                im[i+j]     += ti;
                            }
                        }
                    }

                    // 振幅（magnitude）スペクトル：sqrt(re²+im²)。パワーではない。
                    for (int k = 0; k < spec_bins_fft; ++k)
                        mag[k] = std::sqrt(re[k]*re[k] + im[k]*im[k] + 1e-9f);

                    for (int m = 0; m < kNMels; ++m) {
                        float val = 0.0f;
                        for (int k = 0; k < spec_bins_fft; ++k)
                            val += mel_fb[m][k] * mag[k];
                        mel_spec[t][m] = std::log(std::max(val, kLogFloor));
                    }
                }
            }

            // ----------------------------------------------------------
            // ステップ3: BigVGAN推論
            //
            // chunk_frames = 128  → 65536サンプル出力 (hop=512換算)
            // overlap_frames = 25ms @ hop=512 → ceil(25ms*44100/512) = 3フレーム
            // オーバーラップ部は raised-cosine でブレンド
            // ----------------------------------------------------------
            constexpr int kChunkFrames   = 128;
            constexpr int kOverlapFrames = 3;   // 25ms相当（実測で十分な連続性）
            constexpr int kChunkSamples  = kChunkFrames * kHop;  // 65536
            constexpr int kOverlapSamples = kOverlapFrames * kHop;

            std::vector<float> out_pcm(n_frames * kHop, 0.0f);

            Ort::MemoryInfo mem_info =
                Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

            // 実ONNXモデルの入出力テンソル名（"input_mel"/"output_audio"ではない）
            const char* input_name  = "mel";
            const char* output_name = "audio";

            std::vector<float> chunk_mel(kNMels * kChunkFrames);

            for (int t_start = 0; t_start < n_frames; t_start += kChunkFrames - kOverlapFrames) {
                if (is_cancelled()) return;

                // メルchunkを [1, 128, 128] に充填（足りない部分は末尾フレームで埋める）
                for (int t = 0; t < kChunkFrames; ++t) {
                    const int src_t = std::min(t_start + t, n_frames - 1);
                    for (int m = 0; m < kNMels; ++m)
                        chunk_mel[m * kChunkFrames + t] = mel_spec[src_t][m];
                }

                // ONNX推論
                std::array<int64_t, 3> input_shape  = {1, kNMels, kChunkFrames};
                std::array<int64_t, 3> output_shape = {1, 1, kChunkSamples};

                auto input_tensor = Ort::Value::CreateTensor<float>(
                    mem_info, chunk_mel.data(), chunk_mel.size(),
                    input_shape.data(), input_shape.size());

                auto outputs = g_bigvgan_session->Run(
                    Ort::RunOptions{nullptr},
                    &input_name, &input_tensor, 1,
                    &output_name, 1);

                const float* chunk_out = outputs[0].GetTensorData<float>();

                // オーバーラップアド（raised-cosine ブレンド）
                const int write_sample = t_start * kHop;
                for (int s = 0; s < kChunkSamples; ++s) {
                    const int out_s = write_sample + s;
                    if (out_s >= static_cast<int>(out_pcm.size())) break;

                    if (s < kOverlapSamples && t_start > 0) {
                        // オーバーラップ領域: 前chunkと raised-cosine ブレンド
                        const float fade_in = 0.5f * (1.0f -
                            std::cos(static_cast<float>(M_PI) * s / kOverlapSamples));
                        out_pcm[out_s] = out_pcm[out_s] * (1.0f - fade_in)
                                       + chunk_out[s]   * fade_in;
                    } else {
                        out_pcm[out_s] = chunk_out[s];
                    }
                }

                // 曲末に達したら終了
                if (t_start + kChunkFrames >= n_frames) break;
            }

            // ----------------------------------------------------------
            // ステップ4: BigVGAN出力を double[] に変換して wavwrite
            // ----------------------------------------------------------
            std::vector<double> bigvgan_out(n_src);
            for (int i = 0; i < n_src; ++i)
                bigvgan_out[i] = std::clamp(static_cast<double>(out_pcm[i]), -1.0, 1.0);

            report_progress(95);
            if (is_cancelled()) return;
            wavwrite(bigvgan_out.data(), n_src, out_fs, out_bit_depth, output_path);

        } else {
            // BigVGAN無効時（Pro版としてビルドされているがモデル未ロード時）: WORLD出力をそのまま書き出す
            report_progress(95);
            if (is_cancelled()) return;
            wavwrite(src, n_src, out_fs, out_bit_depth, output_path);
        }
#else
        // 無印版ビルド時: ONNX関連をすべて無視してWORLD出力をそのまま書き出す
        report_progress(95);
        if (is_cancelled()) return;
        wavwrite(src, n_src, out_fs, out_bit_depth, output_path);
#endif
    }

    report_progress(100);
}

// ============================================================
// execute_render / execute_render_cancelable
//   公開APIの2種類:
//     - execute_render: 従来通りのシグネチャ（後方互換用）。
//     - execute_render_cancelable: 進捗コールバックとキャンセルチェックを
//       追加した新API。GUI側（Python）はこちらを使うことでプログレスバーと
//       キャンセルボタンを実装できる。
// ============================================================

DLLEXPORT void execute_render(NoteEvent* notes, int note_count, const char* output_path, int mode_flag)
{
    execute_render_impl(notes, note_count, output_path, mode_flag, nullptr, nullptr);
}

DLLEXPORT void execute_render_cancelable(NoteEvent* notes, int note_count, const char* output_path,
                                          int mode_flag,
                                          ProgressCallback progress_cb,
                                          CancelCheckCallback cancel_cb)
{
    execute_render_impl(notes, note_count, output_path, mode_flag, progress_cb, cancel_cb);
}

// 🚀 【新規追加】PipelineBridgeから転送された構造体配列をC++のベクタにコピーする
DLLEXPORT void set_vocal_timeline(const VoseFrame* frames, int frame_count) {
    VoseUniqueLock lock(g_timeline_mutex);
    g_vocal_timeline.clear();
    
    if (frames != nullptr && frame_count > 0) {
        // O(N)の高速コピー。これでC++側のWORLDやVITS推論器は、
        // いつでも g_vocal_timeline にアクセスして1サンプル単位のウェイトや音素を取得できます。
        g_vocal_timeline.assign(frames, frames + frame_count);
    }
}

// エンジンのバージョン番号を返す
DLLEXPORT float get_engine_version(void)
{
    return 1.0f; // 実際のバージョン番号に置き換えてください
}

// 音声データベース／解析キャッシュをクリアする
DLLEXPORT void clear_engine_cache(void)
{
    {
        VoseUniqueLock lock(g_voice_db_mutex);
        g_voice_db.clear();
    }
    {
        std::lock_guard<std::mutex> lock(g_analysis_cache_mutex);
        g_analysis_cache.clear();
    }
}

} // extern "C"

// ============================================================
// BigVGAN セッション管理
// ============================================================
#ifdef VOSE_PRO
namespace {
    static Ort::Env            g_ort_env{ORT_LOGGING_LEVEL_WARNING, "vose_bigvgan"};
    static Ort::SessionOptions g_ort_opts;
}
#endif

// BigVGAN ONNXモデルのパスを設定する（init_official_engine から呼ぶ）
// path が nullptr または空なら BigVGAN を無効化する
extern "C" DLLEXPORT void set_bigvgan_model(const char* onnx_path) {
#ifdef VOSE_PRO
    std::lock_guard<VoseMutex> lk(g_bigvgan_mutex);
    if (!onnx_path || onnx_path[0] == '\0') {
        g_bigvgan_session.reset();
        return;
    }
    try {
        g_ort_opts.SetIntraOpNumThreads(
            static_cast<int>(std::max(1u, std::thread::hardware_concurrency())));
        g_ort_opts.SetGraphOptimizationLevel(ORT_ENABLE_ALL);
#ifdef _WIN32
        const std::wstring wpath(onnx_path, onnx_path + strlen(onnx_path));
        g_bigvgan_session = std::make_unique<Ort::Session>(g_ort_env, wpath.c_str(), g_ort_opts);
#else
        g_bigvgan_session = std::make_unique<Ort::Session>(g_ort_env, onnx_path, g_ort_opts);
#endif
    } catch (const std::exception& e) {
        // モデルロード失敗時はWORLD直接出力にフォールバック。
        // Git LFSポインタ未取得（.onnx.data が実バイナリでない）等が典型的な原因。
        fprintf(stderr, "[BigVGAN] Failed to load model '%s': %s\n", onnx_path, e.what());
        g_bigvgan_session.reset();
    } catch (...) {
        fprintf(stderr, "[BigVGAN] Failed to load model '%s': unknown error\n", onnx_path);
        g_bigvgan_session.reset();
    }
#else
    (void)onnx_path; // 未使用変数警告の抑制
#endif
}
