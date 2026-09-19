# Example: django-app

Throwaway app used to test the SDK end-to-end against a local LogSetu server. Not published.

See the package README for real usage: [logsetu-django](../../packages/logsetu-django/README.md).

```bash
cp .env.example .env.local   # paste an API key from http://localhost:8686/dashboard/projects
pip install -r requirements.txt && python manage.py migrate && LOGSETU_API_KEY=... python manage.py runserver 8001
```
