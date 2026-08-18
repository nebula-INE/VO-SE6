#config_handler.py

import json
import os

class ConfigHandler:
    def __init__(self, config_path="temp/config.json"):
        self.config_path = config_path
        self.default_config = {
            "last_save_dir": os.path.expanduser("~"),
            "default_voice": "default_voice",
            "volume": 0.8
        }

    def load_config(self):
        """設定を読み込む。ファイルがなければデフォルトを返す"""
        if not os.path.exists(self.config_path):
            os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
            self.save_config(self.default_config)
            return self.default_config
        

        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception: 
            return self.default_config

    def save_config(self, config_dict):
        """現在の設定を保存する"""
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(config_dict, f, indent=4, ensure_ascii=False)
        except Exception as e:
            print(f"Config save error: {e}")
