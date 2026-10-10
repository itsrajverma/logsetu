SECRET_KEY = "test"
DEBUG = False
ALLOWED_HOSTS = ["*"]
ROOT_URLCONF = "tests.urls"
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
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}
USE_TZ = True
LOGGING_CONFIG = None  # tests configure logging themselves
