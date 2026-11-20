from pathlib import Path

from src.files import receipt_path


def test_receipt_path_returns_a_path_object():
    assert isinstance(receipt_path("receipt.txt"), Path)
