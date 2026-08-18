import os

class LicenseManager:
    # --- [リリース時に操作する変数] ---
    # サーバーができるまでは False で配布。
    # 準備ができたら、ここを「サーバーに問い合わせるロジック」に書き換える。
    INTERNAL_PRO_FLAG = False

    @classmethod
    def is_pro(cls):
        """
        有料判定:
        1) VOSE_PLAN が "pro" / "paid" / "enterprise" の場合は Pro 扱い
        2) それ以外は内部フラグ（開発用）を参照
        """
        plan = os.getenv("VOSE_PLAN", "").strip().lower()
        if plan in {"pro", "paid", "enterprise"}:
            return True
        return cls.INTERNAL_PRO_FLAG

    @classmethod
    def get_license_type_name(cls):
        return "Professional" if cls.is_pro() else "Free Edition"
