import logging

from django.http import JsonResponse
from django.urls import path

log = logging.getLogger("demo.views")


def index(request):
    log.info("index viewed", extra={"user_agent": request.headers.get("User-Agent", "")[:60]})
    return JsonResponse({"hello": "world"})


def payroll(request):
    log.warning("payroll run is slow", extra={"duration_ms": 1830, "employees": 412})
    return JsonResponse({"status": "queued"})


def crash(request):
    employees = {}
    return JsonResponse({"salary": employees["missing"]["salary"]})


urlpatterns = [path("", index), path("payroll/", payroll), path("crash/", crash)]
