from django.contrib import admin
from django.urls import path

admin.site.site_header = "Storylex — каталог и черновики"
admin.site.site_title = "Storylex"

urlpatterns = [path("admin/", admin.site.urls)]
