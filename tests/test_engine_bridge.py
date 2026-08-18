from unittest.mock import patch
from modules.gui.core_manager import VoseCoreManager
import pytest

@pytest.mark.smoke
def test_core_manager_fallback():
    with patch('ctypes.CDLL', side_effect=OSError("DLL not found")):
        manager = VoseCoreManager()
        manager._initialized = False
        manager._init_engine()

        assert manager.get_lib() is None
        # None の可能性があるので、is not None を先にチェック
        assert manager._disabled_reason is not None
        assert "DLL not found" in manager._disabled_reason
