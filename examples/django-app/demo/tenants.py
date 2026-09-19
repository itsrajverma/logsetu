def get_tenant_id(request):
    """Multi-tenant apps: derive the tenant from the host, a header, or the user."""
    return request.headers.get("X-Tenant") or request.get_host().split(".")[0]
