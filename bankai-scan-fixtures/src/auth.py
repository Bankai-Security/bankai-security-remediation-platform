"""Intentionally vulnerable authentication examples for scanner testing."""

from src.config import ADMIN_PASSWORD, ADMIN_USERNAME, JWT_SECRET


def find_user(connection, username: str):
    # Fixture: unsafe SQL construction (do not pass untrusted input in real code).
    query = f"SELECT id, username, password FROM users WHERE username = '{username}'"
    return connection.execute(query).fetchone()


def verify_admin(username: str, password: str) -> bool:
    # Fixture: plaintext equality is deliberately weak for password verification.
    return username == ADMIN_USERNAME and password == ADMIN_PASSWORD


def signing_key() -> str:
    # Fixture: returns a source-controlled development key.
    return JWT_SECRET
