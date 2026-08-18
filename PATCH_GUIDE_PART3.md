# VO-SE Pro — GUIビジュアル統一パッチガイド Part 3
## ピッチカーブをピアノロール上へ統合

## まず調査結果から

コードを読んで分かったのですが、これは「未実装」ではなく「**2つの実装が繋がっていない**」状態でした。

- `TimelineWidget`（ピアノロール本体）には `_draw_parameter_curves` / `self.parameters` という
  カーブ描画の仕組みが既にあり、実際にグロー付きの曲線としてピアノロール上に描画されます。
- しかし `self.parameters` は `{"Dynamics", "Pitch", "Vibrato", "Formant"}` という
  **どこからも書き込まれないダミーの辞書**で、常に空のまま描画され続けます。
- 実際に編集可能なパラメーターデータは、下に分離された `GraphEditorWidget` が
  `self.all_parameters = {"Pitch", "Gender", "Tension", "Breath"}` として持っていて、
  ペン描画・ドラッグ・Undo/Redoまで全部ここで完結しています。
- さらに `TimelineWidget.mousePressEvent` は `edit_mode = "draw_parameter"` を
  一度もセットしないため、`mouseMoveEvent`/`mouseReleaseEvent` 側の対応コードは
  存在しても呼ばれることのない死んだコードでした。

つまり「ピアノロール側の描画パイプは存在するが、実データではなく空の辞書を見ている」状態です。
今回は **TimelineWidgetがGraphEditorWidgetの実データを直接参照する**ように繋ぎ直し、
ピッチだけは「そのノートの実音高＋ピッチベンド偏差」から絶対音高を計算して、
ノートと同じY座標系で重ねて描く（＝SynthVのように曲線がノートの上を実際に通る）ようにしました。
Gender/Tension/Breathはピッチのように「絶対音高」の概念がないので、下部に薄い帯グラフとして重ねます。

半音への変換は、C++側の `AutomationRanges::pitchValueToSemitones()` と同じ
`kPitchAutomationSemitoneRange = 2.0`（±2半音）を使っており、エンジン側の実際の
ピッチベンド量とズレないようにしてあります。

**編集操作（ドラッグでカーブを描く）は今回スコープ外です。** `GraphEditorWidget`が
既にペン/ドラッグ/Undo・Redo込みで完成しているので、ピアノロール側に同じ機能を
二重実装すると、ノート移動・リサイズ・矩形選択と操作が競合するリスクが高いです。
SynthVも「ノート上に見える」＝「そこで自由に編集できる」ではなく、精密な編集は
下のパラメーターパネルで行う設計なので、今回は表示の統合のみとしています。

---

## 1. `timeline_widget.py` — `__init__` 内の修正

`self.parameters` / `current_param_layer` は今も `contextMenuEvent` の
「選択したノートのパラメーターをリセット」アクションや、キーボードの1〜4キーでの
レイヤー切り替え（`change_layer`）から参照されているため、**消さずに残します**
（削除すると右クリックメニューがクラッシュします）。新しいオーバーレイ用の
フィールドだけを追加してください。

```python
        self.notes_list: List[Any] = []
        self.parameters: Dict[str, Dict[float, float]] = {
            "Dynamics": {}, "Pitch": {}, "Vibrato": {}, "Formant": {}
        }
        # 🔧 "Dynamics" → "Pitch" に変更: GraphEditorWidget.current_mode の初期値と
        #    揃えておかないと、1〜4キーを押すまで右クリックの「パラメーターをリセット」が
        #    存在しないレイヤー名を参照してしまい常に空振りになる
        self.current_param_layer: str = "Pitch"

        # 🆕 GraphEditorWidgetの実データを直接参照する（ピアノロールのオーバーレイ描画専用。
        #    上の self.parameters とは別物 — そちらは右クリックメニュー等の旧経路互換のために残している）
        self._param_source: Any = None            # set_parameter_source() で設定
        self.show_parameter_overlay: bool = True   # トグルボタンでON/OFF
        # AutomationRanges::kPitchAutomationSemitoneRange (C++側) と必ず一致させること
        self.PITCH_AUTOMATION_SEMITONE_RANGE: float = 2.0

        self.audio_level: float = 0.0
```

新しいメソッドを1つ追加（`__init__`の後、`paintEvent`の前あたりでOK）:

```python
    def set_parameter_source(self, graph_editor_widget: Any) -> None:
        """GraphEditorWidgetの参照を登録する。以後、ピアノロール上のカーブオーバーレイは
        このウィジェットが持つ実データ(all_parameters / current_mode)を直接読みに行く。"""
        self._param_source = graph_editor_widget

    def set_show_parameter_overlay(self, enabled: bool) -> None:
        self.show_parameter_overlay = bool(enabled)
        self.update()
```

---

## 2. `paintEvent` — 描画順序の変更

ノートの上にカーブを重ねて描く（SynthVと同じ見た目）ようにするため、
`_draw_parameter_curves` の呼び出しを `_draw_notes` の**後**に移動します。

```python
    def paintEvent(self, event: QPaintEvent) -> None:
        self._rebuild_note_rects_if_needed()
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)

        p.drawPixmap(0, 0, self._ensure_grid_pixmap())
        self._draw_audio_waveform(p)
        self._draw_glow(p)
        if self.show_ai_phonemes:
            self._draw_ai_phoneme_ghosts(p)

        self._draw_notes(p)                 # ← 先にノート本体を描く
        self._draw_parameter_curves(p)       # ← 🆕 その上からカーブを重ねる（旧: ノートより前だった）
        self._draw_transient_flashes(p)

        self._draw_selection_rect(p)
        self._draw_playhead(p)
        p.end()
```

`_draw_notes` が `self.notes_list.sort(...)` を行うため、この順序ならカーブ側は
常にソート済みのノートリストを安全に参照できます。

---

## 3. `_draw_parameter_curves` / `_draw_curve` を置き換え

既存の2メソッドをまるごと、次の内容に置き換えます。

```python
    def _draw_parameter_curves(self, p: QPainter) -> None:
        if not self.show_parameter_overlay or self._param_source is None:
            return

        source = self._param_source
        all_params = getattr(source, "all_parameters", None)
        if not all_params:
            return

        current_mode = getattr(source, "current_mode", "Pitch")
        colors = getattr(source, "colors", self._PARAM_COLORS)

        # Pitchモードの描画がある場合だけ、ノート検索用の開始時刻リストを1回作る
        note_starts = [n.start_time for n in self.notes_list] if self.notes_list else []

        # 非アクティブなパラメーターは薄いゴースト表示
        for name, events in all_params.items():
            if name == current_mode or not events:
                continue
            self._draw_param_events(p, events, name,
                                     colors.get(name, QColor(200, 200, 200)),
                                     alpha=50, width=1, note_starts=note_starts)

        # アクティブなパラメーターは太く鮮やかに、最後に描いて最前面に
        active_events = all_params.get(current_mode, [])
        if active_events:
            self._draw_param_events(p, active_events, current_mode,
                                     colors.get(current_mode, QColor(255, 255, 255)),
                                     alpha=235, width=2, note_starts=note_starts)

    def _draw_param_events(self, p: QPainter, events: list, mode: str, color: QColor,
                            alpha: int, width: int, note_starts: List[float]) -> None:
        if not events:
            return

        vw = self.width()
        ordered = sorted(events, key=lambda e: e.time)

        glow_color = QColor(color)
        glow_color.setAlpha(int(alpha * 0.30))
        glow_pen = QPen(glow_color, width * 3, Qt.PenStyle.SolidLine,
                        Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin)

        core_color = QColor(color)
        core_color.setAlpha(alpha)
        core_pen = QPen(core_color, width, Qt.PenStyle.SolidLine,
                        Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin)

        prev: Optional[QPointF] = None
        for ev in ordered:
            t = float(ev.time)
            x = self.seconds_to_beats(t) * self.pixels_per_beat - self.scroll_x_offset

            if x > vw + 10:
                break

            y = self._param_value_to_y(mode, t, float(ev.value), note_starts)
            curr = QPointF(x, y)

            if prev is not None and x > -10:
                p.setPen(glow_pen)
                p.drawLine(prev, curr)
                p.setPen(core_pen)
                p.drawLine(prev, curr)

            prev = curr

    def _param_value_to_y(self, mode: str, time_sec: float, value: float,
                          note_starts: List[float]) -> float:
        """パラメーター値をピアノロール上のY座標に変換する。

        Pitch: そのノートの実音高 + ピッチベンド偏差(半音換算) を絶対音高として求め、
               ノート描画と全く同じ座標系 (127 - note_number) * key_height_pixels で
               マッピングする。これによりカーブが実際のノートの上を通って見える。
        それ以外: 0.0〜1.0のパラメーターとして、ピアノロール下部の帯にミニグラフ表示する。
        """
        if mode == "Pitch":
            base_note = self._get_note_pitch_at_time(time_sec, note_starts)
            semitone_offset = (value / 8191.0) * self.PITCH_AUTOMATION_SEMITONE_RANGE
            absolute_pitch = base_note + semitone_offset
            return (127 - absolute_pitch) * self.key_height_pixels - self.scroll_y_offset

        band_h = max(40.0, self.height() * 0.18)
        band_top = self.height() - band_h - 4
        clamped = max(0.0, min(1.0, value))
        return band_top + band_h * (1.0 - clamped)

    def _get_note_pitch_at_time(self, time_sec: float, note_starts: List[float]) -> float:
        """指定時刻を含む(または直前の)ノートの音高を返す。ノートが1つもなければA4(69)を仮定値とする。
        note_starts は self.notes_list と同じ並び順・昇順ソート済みであること。"""
        if not self.notes_list:
            return 69.0
        import bisect
        idx = bisect.bisect_right(note_starts, time_sec) - 1
        if idx < 0:
            return float(self.notes_list[0].note_number)
        return float(self.notes_list[idx].note_number)
```

---

## 4. `main_window.py` — TimelineWidgetとGraphEditorWidgetを接続

`setup_main_editor_area()` の中、`self.graph_editor_widget = GraphEditorWidget()` の
少し後（両方のインスタンスが揃った直後）に1行追加します。

```python
        self.graph_editor_widget = GraphEditorWidget()
        self.graph_editor_widget.pixels_per_beat = self.timeline_widget.pixels_per_beat
        self.graph_editor_widget.parameters_changed.connect(self.on_graph_parameters_changed)
        timeline_splitter.addWidget(self.graph_editor_widget)

        # 🆕 ピアノロール側にGraphEditorWidgetの実データを見せる
        self.timeline_widget.set_parameter_source(self.graph_editor_widget)
```

`on_graph_parameters_changed`（既存メソッド、`GraphEditorWidget.parameters_changed`を
受けているはず）の中で `self.timeline_widget.update()` を呼んでいなければ1行足してください。
カーブをドラッグで編集した瞬間にピアノロール側の重ね描画も即座に追従します。

```python
    def on_graph_parameters_changed(self, all_parameters):
        ...(既存処理)...
        if self.timeline_widget is not None:
            self.timeline_widget.update()   # 🆕 ピアノロール側のオーバーレイも再描画
```

### モード切替時にもピアノロール側を更新

`on_param_mode_changed()` の最後に1行追加すると、Pitch/Gender/Tension/Breathを
切り替えた瞬間にピアノロール上でどの曲線が明るく表示されるかも切り替わります。

```python
    def on_param_mode_changed(self, button):
        ...(既存処理)...
        status_bar = self.statusBar()
        if status_bar:
            status_bar.showMessage(f"編集モード: {mode}")

        if self.timeline_widget is not None:   # 🆕
            self.timeline_widget.update()
```

---

## 5. 右クリックメニューとキーボードショートカットを実データに繋ぎ直す（推奨）

`_clear_selected_params`（右クリック→「選択したノートのパラメーターをリセット」）と
`change_layer`（1〜4キーでのレイヤー切替）は、これまで誰も書き込まないダミーの
`self.parameters` を操作していたため、実質何も起きていませんでした。ついでに
実データ（`GraphEditorWidget.all_parameters`）へ向け直すと、この2つの機能が
初めてちゃんと動くようになります。両方とも既存メソッドの置き換えです。

```python
    def change_layer(self, name: str) -> None:
        self.current_param_layer = name
        if self._param_source is not None and hasattr(self._param_source, "set_mode"):
            self._param_source.set_mode(name)   # 🆕 GraphEditorWidget側も追従させる
        main_win = self.window()
        if isinstance(main_win, QMainWindow):
            sb = main_win.statusBar()
            if sb:
                sb.showMessage(f"Active Layer: {name}", 2000)
        self.update()
        logger.info(f"Graph Editor: Layer changed to '{name}'")
```

```python
    def _clear_selected_params(self) -> None:
        """選択中のノートの時間範囲にある、現在のレイヤーのパラメーターポイントを削除する。
        🆕 GraphEditorWidgetの実データ(all_parameters)を操作するように変更。"""
        source = self._param_source
        if source is None or not hasattr(source, "all_parameters"):
            return

        layer = self.current_param_layer
        events = source.all_parameters.get(layer)
        if not events:
            return

        selected_ranges = [
            (n.start_time, n.start_time + n.duration)
            for n in self.notes_list if getattr(n, 'is_selected', False)
        ]
        if not selected_ranges:
            return

        before = source._snapshot_parameters() if hasattr(source, "_snapshot_parameters") else None
        events[:] = [
            ev for ev in events
            if not any(start <= ev.time <= end for start, end in selected_ranges)
        ]

        if hasattr(source, "parameters_changed"):
            source.parameters_changed.emit(source.all_parameters)
        if before is not None and hasattr(source, "_commit_edit"):
            source._commit_edit(before, f"{layer} パラメーターリセット")

        source.update()
        self.update()
```

> 右クリックメニュー側の文言 `f"選択したノートの {self.current_param_layer} をリセット"`
> はそのままで問題ありません（`current_param_layer`は`change_layer`経由で更新されるため）。

---

## 6. ツールバーにオーバーレイ表示のON/OFFトグルを追加（任意）

Part 1の `setup_toolbar()` に足す場合の例です（`pen_mode_action` の近くに追加）:

```python
    from modules.gui.icons import icon
    self.pitch_overlay_action = QAction(icon("pitch_curve"), " ピッチカーブ表示", self)
    self.pitch_overlay_action.setCheckable(True)
    self.pitch_overlay_action.setChecked(True)
    self.pitch_overlay_action.toggled.connect(
        lambda checked: self.timeline_widget.set_show_parameter_overlay(checked)
        if self.timeline_widget else None
    )
    self.toolbar.addAction(self.pitch_overlay_action)
```

（`assets/icons/dark/pitch_curve.svg` ・ `assets/icons/light/pitch_curve.svg` を追加済みです）

---

## 適用後にひと目で変わること

- ピッチカーブが、そのノートの実際の音高を基準に**ノートの上を通る形**でピアノロールに重ねて表示される
  （C++エンジン側の `pitchValueToSemitones()` と同じ ±2半音換算を使っているので、実際に鳴る音と表示がズレない）
- Gender/Tension/Breathは下部の薄い帯グラフとして重ねて表示される（選択中のパラメーターだけ鮮やかに）
- Pitch/Gender/Tension/Breathの切り替えボタンが、下のGraphEditorWidgetだけでなくピアノロール側の
  ハイライト表示にも即座に反映される
- カーブの実編集は引き続き下のGraphEditorWidgetで行う（ペン/ドラッグ/Undo・Redo対応済み）
- 死んでいた `self.parameters` ダミー辞書と、一度も呼ばれなかった `edit_mode == "draw_parameter"` 系の
  死にコードが整理される
