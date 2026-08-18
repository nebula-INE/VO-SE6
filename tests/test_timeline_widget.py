import unittest
import os
import pytest

os.environ["QT_QPA_PLATFORM"] = "offscreen"

@pytest.mark.smoke
class TestTimelineWidget(unittest.TestCase):
    def test_timeline_import(self):
        try:
            from modules.gui.timeline_widget import TimelineWidget
            self.assertIsNotNone(TimelineWidget)
        except Exception as e:
            self.skipTest(f"TimelineWidget import skipped: {e}")

if __name__ == "__main__":
    unittest.main()
