# Container voor de Blom App. GitHub bouwt deze automatisch bij elke push naar
# main (zie .github/workflows/container.yml). Je gegevens zitten niet in de
# container: die staan in /data, dat in Unraid naar de appdata-map wijst.
# 'slim' in plaats van 'alpine': het pakket anthropic heeft onderdelen die
# voor slim kant-en-klaar beschikbaar zijn.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py ./
COPY core ./core
COPY gedeeld ./gedeeld
COPY portaal ./portaal
COPY modules ./modules

ENV DATA_DIR=/data \
    PORT=8080 \
    PYTHONDONTWRITEBYTECODE=1
VOLUME /data
EXPOSE 8080

CMD ["python", "-u", "server.py"]
