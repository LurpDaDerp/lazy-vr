# LazyVR: the static page plus the search/stream server, one container.
#
#   docker build -t lazyvr .
#   docker run -p 8360:8360 lazyvr
#
# Put TLS in front of it (the platform's ingress, or any reverse proxy):
# the camera API the gaze tracker needs only exists on HTTPS pages.

FROM python:3.13-slim

WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server server
COPY site site

EXPOSE 8360
CMD ["python", "server/app.py", "--host", "0.0.0.0", "--port", "8360"]
