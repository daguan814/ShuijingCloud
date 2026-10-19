import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent

STORAGE_ROOT = Path(
    os.getenv("STORAGE_ROOT", str(BASE_DIR / "storage"))
).resolve()
RECYCLE_ROOT = Path(
    os.getenv("RECYCLE_ROOT", str(STORAGE_ROOT / "回收站"))
).resolve()
RECYCLE_BIN_PASSWORD = os.getenv("RECYCLE_BIN_PASSWORD", "")
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "shuijing")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")

DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "ShuijingCloud")
DB_DRIVER = os.getenv("DB_DRIVER", "mysql").strip().lower()
SQLITE_DB_PATH = os.getenv(
    "SQLITE_DB_PATH",
    str(BASE_DIR / "shuijingcloud.db"),
)

APP_HOST = os.getenv("APP_HOST", "0.0.0.0")
APP_PORT = int(os.getenv("APP_PORT", "8080"))
MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_LENGTH", str(10 * 1024 * 1024 * 1024)))
SECRET_KEY = os.getenv("SECRET_KEY", "shuijing-cloud-preview-secret-change-me")
ALLOWED_ORIGINS = {
    item.strip()
    for item in os.getenv("ALLOWED_ORIGINS", "http://127.0.0.1:5173").split(",")
    if item.strip()
}

DEFAULT_USERS = ["shuijing", "txt"]

# kkFileView is accessed only through the same public Nginx endpoint.  These
# values can be overridden in production without embedding a host in code.
PREVIEW_PUBLIC_URL = os.getenv("PREVIEW_PUBLIC_URL", "https://shuijing.site:8080").rstrip("/")
KKFILEVIEW_URL = os.getenv("KKFILEVIEW_URL", f"{PREVIEW_PUBLIC_URL}/kk").rstrip("/")
KK_PREVIEW_MAX_AGE = int(os.getenv("KK_PREVIEW_MAX_AGE", "600"))
