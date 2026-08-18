# VO-SE Pro — GUIビジュアル統一パッチガイド Part 2
## トラックミキサーストリップ ＋ ボイスギャラリー検索/カテゴリ絞り込み

Part 1（`PATCH_GUIDE.md`）を適用済みであることが前提です。
今回追加したファイル:

```
modules/gui/track_strip.py           ← 新規: TrackStripWidget
modules/gui/voice_gallery_patch.py   ← VoiceCardWidget/VoiceCardGalleryの置き換え版
assets/icons/dark/search.svg, clear_x.svg   ← 新規アイコン
assets/icons/light/search.svg, clear_x.svg  ← 同上
themes/dark.qss / light.qss          ← Part1版に追記した完全版（丸ごと上書きでOK）
```

---

## A. ボイスギャラリー（検索・カテゴリ絞り込み）

`modules/gui/voice_gallery_patch.py` の中身を、`main_window.py` の
`class VoiceCardWidget(QFrame):` から `class AnalysisThread(QThread):` の
**直前まで**を丸ごと置き換えてください。

`setup_voice_gallery()` 側の呼び出し（`VoiceCardGallery(...)`, `set_partner_data(...)`,
`setup_gallery()`, `voice_selected.connect(...)`）はAPIを変えていないので**変更不要**です。

やったことは:
- `VoiceCardWidget` に `category`（`"official"` / `"utau"` / `"recruiting"`）と
  `matches(query, category_filter)` を追加
- `VoiceCardGallery` の先頭に検索バー(`QLineEdit#SearchField`)とカテゴリチップ
  (`すべて` / `内蔵` / `UTAU音源` / `募集枠`)を追加
- 絞り込みは音源の再スキャンをせず、生成済みカードをグリッドへ再配置するだけ
  （`_apply_filter()`）なので、入力のたびに音源フォルダを読み直したりしません
- 該当0件のときは `GalleryEmptyState` ラベルを表示

---

## B. トラックミキサーストリップ

### B-1. import追加

`main_window.py` の先頭（他の `from modules.gui...` importの近く）に1行追加:

```python
from modules.gui.track_strip import TrackStripWidget
```

### B-2. `setup_main_editor_area()` — 独立ミキサーUIの呼び出しを削除

トラックごとの音量/M/Sはリストの各行（TrackStripWidget）に統合されたため、
リストの下に付けていた共通ミキサーは不要になります。

```python
        track_layout.addWidget(self.track_list_widget)

        # 🗑️ 削除: 以前はここでリスト下に共通ミキサーを追加していた
        # mixer_layout = self.setup_mixer_controls()
        # track_layout.addLayout(mixer_layout)
```

`self.track_list_widget = QListWidget()` や `setObjectName("TrackList")` は
そのまま残してください（Part 1で追加したQSSの `QListWidget#TrackList::item` が
これを前提にしています）。

### B-3. `refresh_track_list_ui()` を置き換え

```python
    def refresh_track_list_ui(self):
        """UI上のリスト表示を最新状態に同期（各行=TrackStripWidgetとして再構築）"""
        if not self.track_list_widget:
            return

        from PySide6.QtWidgets import QListWidgetItem
        from PySide6.QtCore import QSize

        self.track_list_widget.blockSignals(True)
        self.track_list_widget.clear()
        self._track_strips = []

        for t in self.tracks:
            strip = TrackStripWidget(t)
            strip.selected.connect(self._on_strip_selected)
            strip.mute_toggled.connect(self._on_strip_mute)
            strip.solo_toggled.connect(self._on_strip_solo)
            strip.volume_changed.connect(self._on_strip_volume)
            strip.pan_changed.connect(self._on_strip_pan)
            strip.name_edited.connect(self._on_strip_renamed)

            item = QListWidgetItem()
            item.setSizeHint(QSize(strip.sizeHint().width(), 64))
            self.track_list_widget.addItem(item)
            self.track_list_widget.setItemWidget(item, strip)
            self._track_strips.append(strip)

        # 現在の選択行を維持（範囲チェック付き）
        if 0 <= self.current_track_idx < self.track_list_widget.count():
            self.track_list_widget.setCurrentRow(self.current_track_idx)

        self._sync_track_strips()
        self.track_list_widget.blockSignals(False)

    def _sync_track_strips(self):
        """Mute/Solo状態が他トラックの見た目に影響する部分だけをまとめて更新"""
        solo_exists = any(t.is_solo for t in self.tracks)
        for strip in getattr(self, '_track_strips', []):
            t = strip.track
            dimmed = t.is_muted or (solo_exists and not t.is_solo)
            strip.set_dimmed(dimmed)

    # --- TrackStripWidget からのコールバック ---

    def _on_strip_selected(self, track):
        if track in self.tracks:
            idx = self.tracks.index(track)
            self.track_list_widget.setCurrentRow(idx)  # switch_track(idx) が追従する

    def _on_strip_mute(self, track, checked):
        self._sync_track_strips()
        self.statusBar().showMessage(f"{track.name} Muted: {checked}")

    def _on_strip_solo(self, track, checked):
        self._sync_track_strips()
        self.statusBar().showMessage(f"{track.name} Solo: {checked}")

    def _on_strip_volume(self, track, value):
        # ドラッグ中に毎回呼ばれるため軽量に。リスト再構築は絶対にしない。
        if (hasattr(self, 'audio_output') and track.track_type == "wave"
                and 0 <= self.current_track_idx < len(self.tracks)
                and self.tracks[self.current_track_idx] is track):
            self.audio_output.setVolume(value)

    def _on_strip_pan(self, track, value):
        # 値は TrackStripWidget 側で track.pan に反映済み。
        # パンをエンジン(vo_se_engine)に伝える処理が必要になったらここに追加。
        pass

    def _on_strip_renamed(self, track, new_name):
        self.statusBar().showMessage(f"トラック名を '{new_name}' に変更しました", 3000)
```

### B-4. `switch_track()` — 旧共通ミキサーへの同期処理を削除

```python
        # 5. UI（ミキサー等）の同期
        # 🗑️ 削除: vol_slider / vol_label / btn_mute / btn_solo はもう存在しない
        # vol_slider = getattr(self, 'vol_slider', None)
        # ...(中略、この5〜6行のブロックを丸ごと削除)...
```

（trackを切り替えたときの各行ハイライトは、QSS側の `QListWidget#TrackList::item:selected`
がそのまま担当するので、追加コードは不要です）

### B-5. 不要になった旧メソッドの削除

以下は `TrackStripWidget` に役割が移ったため、丸ごと削除してください
（他から呼ばれていないか一応 `grep -rn` で確認してから）:

- `setup_track_controls()`
- `toggle_mute()`
- `toggle_solo()`
- `setup_mixer_controls()`
- `on_volume_changed()`

`get_active_tracks()` はそのまま使えるので**残してください**（再生エンジン側が参照）。

---

## 適用後にひと目で変わること

- トラック一覧の各行に、そのトラック専用の M / S ボタン・パン・フェーダー・音量%表示が常設される
  （選択中トラックだけでなく、全トラックを同時に見比べながら調整できる＝DAW/SynthVと同じ操作感）
- トラック名がその場でダブルクリック不要のインライン編集に（`QLineEdit`）
- フェーダーをドラッグしている間もリストは再構築されないので、カクつきやフォーカス落ちが起きない
- ボイスギャラリーが検索窓＋4つのカテゴリチップで即座に絞り込めるようになる
- 音源が1件も見つからないときに「該当する音源が見つかりません」という空状態が出るようになる
