import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = "example-only-not-secret"
DEBUG = False
ALLOWED_HOSTS = ["*"]
ROOT_URLCONF = "demo.urls"
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "logsetu",
]
MIDDLEWARE = [
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "logsetu.middleware.LogSetuMiddleware",
]
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}}
USE_TZ = True

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {
        "console": {"class": "logging.StreamHandler"},
        "logsetu": {
            "class": "logsetu.handler.LogSetuHandler",
            "api_key": os.environ.get("LOGSETU_API_KEY", ""),
            "endpoint": os.environ.get("LOGSETU_ENDPOINT", "http://localhost:8686"),
            "environment": os.environ.get("ENVIRONMENT", "development"),
            "source": "django-backend",
            "level": "INFO",
            "get_tenant_id": "demo.tenants.get_tenant_id",
            "debug": True,
        },
    },
    "root": {"handlers": ["console", "logsetu"], "level": "INFO"},
}
