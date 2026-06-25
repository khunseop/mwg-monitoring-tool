"""암호화/복호화 유틸리티 테스트"""
from app.utils.crypto import encrypt_string, decrypt_string_if_encrypted


def test_encrypt_decrypt_roundtrip():
    original = "my_secret_password"
    encrypted = encrypt_string(original)
    assert encrypted is not None
    assert encrypted.startswith("enc$")
    decrypted = decrypt_string_if_encrypted(encrypted)
    assert decrypted == original


def test_encrypt_none_returns_none():
    assert encrypt_string(None) is None


def test_encrypt_empty_returns_none():
    assert encrypt_string("") is None


def test_decrypt_none_returns_none():
    assert decrypt_string_if_encrypted(None) is None


def test_decrypt_plaintext_passthrough():
    # enc$ 접두사 없으면 레거시 평문으로 처리
    assert decrypt_string_if_encrypted("plaintext_value") == "plaintext_value"


def test_decrypt_invalid_token_returns_none():
    assert decrypt_string_if_encrypted("enc$invalid_token_garbage") is None


def test_encrypted_values_are_unique():
    # 동일한 값이라도 매번 다른 토큰 생성 (Fernet nonce)
    enc1 = encrypt_string("password")
    enc2 = encrypt_string("password")
    assert enc1 != enc2
    # 하지만 복호화 결과는 동일해야 함
    assert decrypt_string_if_encrypted(enc1) == decrypt_string_if_encrypted(enc2) == "password"
