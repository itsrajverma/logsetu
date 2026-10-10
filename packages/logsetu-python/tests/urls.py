import logging

from django.http import HttpResponse, JsonResponse
from django.urls import path

log = logging.getLogger("tests.views")


def ok(request):
    log.info("view ran", extra={"order_id": 42})
    return JsonResponse({"ok": True})


def boom(request):
    raise ValueError("kaboom")


def server_error(request):
    return HttpResponse("nope", status=502)


urlpatterns = [path("ok/", ok), path("boom/", boom), path("bad-gateway/", server_error)]
