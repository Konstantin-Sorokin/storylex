"""Only published public content is reachable via the temporary HTTPS tunnel.

OAuth routes will be added in the separately approved provider spike.
Admin, dev/session and the stage 1.5 sync routes stay on the local listener.
"""

from django.urls import include, path

urlpatterns = [path("api/v1/", include("apps.content.api"))]
