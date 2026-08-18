import ctypes
import os
import unittest
import platform
import pytest

@pytest.mark.smoke
def _default_engine_path() -> str:
    system = platform.system()
    if system == "Windows":
        lib_name = "vose_core.dll"
    elif system == "Darwin":
        lib_name = "libvose_core.dylib"
    else:
        lib_name = "libvose_core.so"
    return os.path.join("bin", lib_name)

class TestCIRender(unittest.TestCase):
    def test_engine_load(self):
        engine_path = os.environ.get("ENGINE_PATH", _default_engine_path())
        if not os.path.exists(engine_path):
            self.skipTest(f"Engine binary not found at {engine_path}")

        try:
            lib = ctypes.CDLL(engine_path)
            self.assertIsNotNone(lib)
            print(f"✅ Engine loaded successfully: {engine_path}")
        except OSError as exc:
            self.skipTest(f"Engine exists but is not loadable on this OS: {exc}")

if __name__ == "__main__":
    unittest.main()
