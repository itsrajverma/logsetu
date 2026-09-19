import logging

from django.http import JsonResponse
from django.urls import path

log = logging.getLogger("demo.views")


def index(request):
    log.info("index viewed", extra={"user_agent": request.headers.get("User-Agent", "")[:60]})
    return JsonResponse({"hello": "world"})


def checkout(request):
    log.warning("checkout is slow", extra={"duration_ms": 1830, "cart_items": 12})
    return JsonResponse({"status": "queued"})


def crash(request):
    employees = {}
    return JsonResponse({"salary": employees["missing"]["salary"]})


urlpatterns = [path("", index), path("checkout/", checkout), path("crash/", crash)]
