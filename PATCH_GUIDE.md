# VO-SE Pro — GUIビジュアル統一パッチガイド

Synthesizer Vのようなプロツールらしい統一感を出すための第一弾（全体のビジュアル統一）です。
やったことは3つだけです。

1. `themes/dark.qss` / `themes/light.qss` を刷新（絵文字ボタンのインライン`setStyleSheet`に
   頼らず、QSS側だけで統一感が出るように再設計）
2. lucideスタイルのSVGアイコンを19個追加（`assets/icons/dark/`, `assets/icons/light/`）
3. `modules/gui/icons.py` を新規追加（テーマに連動してアイコンを取り出すヘルパー）

これに合わせて `main_window.py` 側を数箇所直す必要があります。以下、該当メソッドごとに
「現在のコード → 変更後」で示します。すべて既存メソッドの**置き換え**です（新規メソッド追加はicons importのみ）。

---

## 0. ファイル配置

```
VO-SE-Pro/
├── assets/
│   └── icons/
│       ├── dark/    ← 19個のsvg（ダーク用・薄いグレー系ストローク）
│       └── light/   ← 19個のsvg（ライト用・濃いグレー系ストローク）
├── modules/gui/
│   └── icons.py     ← 新規
└── themes/
    ├── dark.qss      ← 置き換え
    └── light.qss     ← 置き換え
```

---

## 1. `modules/gui/themes.py` — テーマ切替時にアイコン配色も同期させる

`apply_theme()` の中、スタイルシート適用が成功した直後に1行追加するだけです。

```python
def apply_theme(theme_name: str) -> bool:
    ...
    if file.open(QIODevice.OpenModeFlag.ReadOnly | QIODevice.OpenModeFlag.Text):
        try:
            stream = QTextStream(file)
            stream.setEncoding(QStringConverter.Encoding.Utf8)
            qss = stream.readAll()
            app.setStyleSheet(qss)

            # 🆕 アイコン配色セットもテーマに同期
            from modules.gui.icons import set_icon_theme
            set_icon_theme(theme_name if theme_name in ("dark", "light") else "dark")

            return True
```

---

## 2. `main_window.py` — `setup_toolbar()` を置き換え

絵文字テキストの代わりにSVGアイコンを使い、`objectName`をQSSの新しいセレクタに合わせます。
`open_wav_btn` は `SecondaryButton`、`render_btn` は `PrimaryButton` のままでOK（今回QSS側に
実体を追加したので、既存の`objectName`指定がようやく効くようになります）。

```python
def setup_toolbar(self):
    """上部ツールバー：再生・録音・テンポ・ファイル操作（アイコン統一版）"""
    from PySide6.QtWidgets import QToolBar, QPushButton, QLabel, QLineEdit, QWidget, QSizePolicy
    from PySide6.QtCore import QSettings, QSize
    from PySide6.QtGui import QAction
    from modules.gui.icons import icon

    ICON_SIZE = QSize(16, 16)

    self.toolbar = QToolBar("Main Toolbar")
    self.addToolBar(self.toolbar)
    self.toolbar.setMovable(False)
    self.toolbar.setIconSize(ICON_SIZE)

    # 1. 再生コントロール（セグメント連結）
    self.play_btn = QPushButton(icon("play"), " 再生")
    self.play_btn.setObjectName("SegmentLeft")
    self.play_btn.setCheckable(True)
    self.play_btn.clicked.connect(self.on_play_pause_toggled)
    self.toolbar.addWidget(self.play_btn)

    self.stop_btn = QPushButton(icon("stop"), " 停止")
    self.stop_btn.setObjectName("SegmentMid")
    self.stop_btn.setCheckable(True)
    self.stop_btn.clicked.connect(self.stop_and_clear_playback)
    self.toolbar.addWidget(self.stop_btn)

    self.loop_btn = QPushButton(icon("loop"), " ループ")
    self.loop_btn.setObjectName("SegmentRight")
    self.loop_btn.setCheckable(True)
    self.loop_btn.clicked.connect(self.on_loop_button_toggled)
    self.toolbar.addWidget(self.loop_btn)

    self.toolbar.addSeparator()

    # 時刻表示（インラインstyleSheetを廃止 → objectNameでQSS管理）
    self.time_display_label = QLabel("00:00.000 / 00:00.000")
    self.time_display_label.setObjectName("TimeDisplay")
    self.time_display_label.setMinimumWidth(150)
    self.time_display_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
    self.toolbar.addWidget(self.time_display_label)

    self.toolbar.addSeparator()

    # 読み上げ
    self.talk_button = QPushButton(icon("talk"), " 読み上げ")
    self.talk_button.clicked.connect(self.on_talk)
    self.toolbar.addWidget(self.talk_button)

    # 2. テンポ設定
    self.toolbar.addWidget(QLabel(" Tempo: "))
    self.tempo_input = QLineEdit("120")
    self.tempo_input.setFixedWidth(44)
    self.tempo_input.returnPressed.connect(self.update_tempo_from_input)
    self.toolbar.addWidget(self.tempo_input)

    self.toolbar.addSeparator()

    # 3. WAVファイル読み込み
    self.open_wav_btn = QPushButton(icon("open_folder"), " OPEN WAV")
    self.open_wav_btn.setObjectName("SecondaryButton")
    self.open_wav_btn.clicked.connect(self.open_audio)
    self.toolbar.addWidget(self.open_wav_btn)

    # 4. Cエンジン・レンダリング
    self.render_btn = QPushButton(icon("render_export"), " RENDER")
    self.render_btn.setObjectName("PrimaryButton")
    self.render_btn.clicked.connect(self.on_render_button_clicked)
    self.toolbar.addWidget(self.render_btn)

    # ペンモードトグル
    self.pen_mode_action = QAction(icon("pen"), " ペンモード", self)
    self.pen_mode_action.setCheckable(True)
    self.pen_mode_action.triggered.connect(self.on_pen_mode_toggled)
    self.toolbar.addAction(self.pen_mode_action)

    # オートチューン
    auto_tune_action = QAction(icon("auto_tune"), " オートチューン", self)
    auto_tune_action.triggered.connect(self.auto_tune_selected)
    self.toolbar.addAction(auto_tune_action)

    # 右端を整えるためのスペーサー
    spacer = QWidget()
    spacer.setSizePolicy(QSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred))
    self.toolbar.addWidget(spacer)

    settings = QSettings("VO-SE", "vocal")
    current_theme = settings.value("theme", "dark")
    theme_icon = icon("theme_moon") if current_theme == "light" else icon("theme_sun")
    theme_text = " ダークモードへ" if current_theme == "light" else " ライトモードへ"

    self.theme_btn = QPushButton(theme_icon, theme_text)
    self.theme_btn.setObjectName("SecondaryButton")
    self.theme_btn.clicked.connect(self.toggle_theme)
    self.toolbar.addWidget(self.theme_btn)
```

> `QSettings("VO-SE", "Pro")` になっていた箇所を `"vocal"` に修正しています
> （`load_theme_setting`/`toggle_theme`はすでに`"vocal"`を使っているので、
> ここだけ`"Pro"`のままだと起動直後のアイコン/テキストが実際のテーマとズレます）。

---

## 3. `main_window.py` — `toggle_theme()` にアイコン更新を追加

テーマ切替時、ツールバーのアイコンも塗り直します（テキストだけでなくアイコンも）。

```python
def toggle_theme(self):
    """テーマの切り替えと保存、UIの更新を行う"""
    from modules.gui.themes import apply_theme
    from modules.gui.icons import icon
    from PySide6.QtCore import QSettings

    settings = QSettings("VO-SE", "vocal")
    current = settings.value("theme", "dark")
    new_theme = "light" if current == "dark" else "dark"

    if apply_theme(new_theme):  # 内部で icons.set_icon_theme() も呼ばれる
        settings.setValue("theme", new_theme)
        self.statusBar().showMessage(f"テーマを {new_theme} に切り替えました", 3000)

        if hasattr(self, 'theme_btn'):
            self.theme_btn.setText(" ダークモードへ" if new_theme == "light" else " ライトモードへ")
            self.theme_btn.setIcon(icon("theme_moon") if new_theme == "light" else icon("theme_sun"))

        # ツールバーの主要アイコンも塗り直す
        for attr, name in (
            ("play_btn", "play"), ("stop_btn", "stop"), ("loop_btn", "loop"),
            ("talk_button", "talk"), ("open_wav_btn", "open_folder"),
            ("render_btn", "render_export"),
        ):
            btn = getattr(self, attr, None)
            if btn is not None:
                btn.setIcon(icon(name))
```

---

## 4. `main_window.py` — `setup_control_panel()` の録音ボタン・AIボタン・編集モードボタン

インラインの`setStyleSheet(...)`をすべて廃止し、`objectName`と動的プロパティに寄せます。

```python
def setup_control_panel(self):
    from modules.gui.icons import icon
    panel_layout = QHBoxLayout()

    # 録音コントロール（危険色はQSS側の #RecordButton が担当）
    self.record_button = QPushButton(icon("record"), " 録音")
    self.record_button.setObjectName("RecordButton")
    self.record_button.setCheckable(True)
    self.record_button.clicked.connect(self.on_record_toggled)
    panel_layout.addWidget(self.record_button)

    panel_layout.addSpacing(12)

    panel_layout.addWidget(QLabel("Voice:"))
    self.character_selector = QComboBox()
    panel_layout.addWidget(self.character_selector)

    panel_layout.addWidget(QLabel("MIDI:"))
    self.midi_port_selector = QComboBox()
    self.midi_port_selector.addItem("ポートなし", None)
    self.midi_port_selector.currentIndexChanged.connect(self.on_midi_port_changed)
    panel_layout.addWidget(self.midi_port_selector)

    self.open_button = QPushButton(icon("open_folder"), " 開く")
    self.open_button.setObjectName("SecondaryButton")
    self.open_button.clicked.connect(self.open_file_dialog_and_load_midi)
    panel_layout.addWidget(self.open_button)

    self.rescan_voices_button = QPushButton(icon("rescan"), " 音源再スキャン")
    self.rescan_voices_button.setObjectName("SecondaryButton")
    self.rescan_voices_button.clicked.connect(self.refresh_voice_list)
    panel_layout.addWidget(self.rescan_voices_button)

    panel_layout.addSpacing(12)

    # AI解析ボタン（旧: background-color:#4A90E2 のインライン直書きを廃止）
    self.ai_analyze_button = QPushButton(icon("ai_wand"), " AI Auto Setup")
    self.ai_analyze_button.setObjectName("PrimaryButton")
    self.ai_analyze_button.clicked.connect(self.start_batch_analysis)
    panel_layout.addWidget(self.ai_analyze_button)

    self.auto_lyrics_button = QPushButton(icon("lyrics"), " 自動歌詞配置")
    self.auto_lyrics_button.setObjectName("SecondaryButton")
    self.auto_lyrics_button.clicked.connect(self.on_click_auto_lyrics)
    panel_layout.addWidget(self.auto_lyrics_button)

    # --- パラメーター切り替えボタン ---
    # 旧: btn.setStyleSheet(f"QPushButton:checked {{ background-color: {color}; ... }}")
    # 新: 動的プロパティ role/paramColor を付けてQSS側([role="paramToggle"])に任せる
    panel_layout.addSpacing(20)
    panel_layout.addWidget(QLabel("Edit Mode:"))

    self.param_group = QButtonGroup(self)
    self.param_buttons = {}

    param_list = [
        ("Pitch", "pitch"),
        ("Gender", "gender"),
        ("Tension", "tension"),
        ("Breath", "breath"),
    ]

    for name, color_key in param_list:
        btn = QPushButton(name)
        btn.setCheckable(True)
        btn.setProperty("role", "paramToggle")
        btn.setProperty("paramColor", color_key)

        # 動的プロパティを使ったQSSセレクタはtoggle時に自動で再評価されない場合が
        # あるため、チェック状態が変わるたびに明示的に再ポリッシュする
        def _repolish(checked, b=btn):
            b.style().unpolish(b)
            b.style().polish(b)
        btn.toggled.connect(_repolish)

        if name == "Pitch":
            btn.setChecked(True)

        panel_layout.addWidget(btn)
        self.param_group.addButton(btn)
        self.param_buttons[name] = btn

    self.param_group.buttonClicked.connect(self.on_param_mode_changed)

    panel_layout.addStretch()
    self.main_layout.addLayout(panel_layout)
```

---

## 5. `main_window.py` — トラックパネルとセクション見出しに`objectName`

`setup_main_editor_area()` の中、`track_panel` 生成部分に1行、"TRACKS"ラベルに1行足すだけです。

```python
self.track_panel = QFrame()
self.track_panel.setObjectName("TrackPanel")          # 🆕
self.track_panel.setFrameShape(QFrame.Shape.StyledPanel)
self.track_panel.setMinimumWidth(200)
self.track_panel.setMaximumWidth(400)
...
tracks_heading = QLabel("TRACKS")
tracks_heading.setObjectName("SectionHeading")          # 🆕
track_layout.addWidget(tracks_heading)                  # 従来の QLabel("TRACKS") をこれに置き換え
```

---

## 6. `main_window.py` — 死んでいる `apply_apple_refined_style()` を削除

`init_ui()`側からはすでに呼ばれておらず（コメントにも「廃止」と書かれている）、
中身は今回`themes/dark.qss`に統合したので、メソッドごと削除してOKです。
呼び出し箇所が他に残っていないか一応 `grep -rn apply_apple_refined_style` で確認してください。

---

## 適用後にひと目で変わること

- ツールバー・コントロールパネルのボタンが絵文字→ベクターアイコンに統一される
- `RENDER` / `AI Auto Setup` / `OPEN WAV` などがボタンごとにバラバラだった色指定から、
  `PrimaryButton` / `SecondaryButton` という2階層の意味づけに統一される
- 再生/停止/ループのセグメントボタンが、実際に連結ピル型のセグメントコントロールとして描画される
  （これまでは`apply_apple_refined_style`が呼ばれていなかったため、実質ただの3つのボタンだった）
- Edit Modeの4ボタン（Pitch/Gender/Tension/Breath）が、色ベタ塗りではなく
  「選択中は該当色の縁取り＋薄いティント」という上品な表現になる
- ドック（エフェクトチェーン等）のタイトルバー、トラックリストの選択行、メニュー、
  スクロールバーなどQSS未対応だった部分に統一スタイルが行き渡る

## 次にやると効果が大きいこと（今回のスコープ外）

- トラックパネルへのフェーダー/パン付きミキサーストリップ導入
- ボイスギャラリーへの検索・タグ絞り込み・ホバープレビュー
- ピッチカーブをピアノロール上に直接オーバーレイ表示
