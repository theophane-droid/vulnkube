#!/usr/bin/env python3
import argparse
import json
import math
import time
import urllib.error
import urllib.request


TRACKS = {
    "AFR431": [
        (48.99, 2.55, 12000, 150),
        (47.90, 2.95, 21000, 154),
        (46.18, 3.12, 31000, 152),
        (44.72, 4.55, 33000, 148),
        (43.66, 6.35, 19000, 136),
    ],
    "DLH220": [
        (49.82, 6.20, 30000, 246),
        (49.42, 5.12, 24000, 246),
        (49.02, 4.40, 18000, 246),
        (48.89, 3.42, 12000, 252),
        (49.01, 2.55, 5000, 260),
    ],
    "BOX808": [
        (43.62, 1.36, 9000, 332),
        (45.24, 0.78, 18000, 336),
        (47.92, 0.62, 26000, 338),
        (49.88, 0.12, 30000, 332),
    ],
    "NAVY86": [
        (48.52, -4.15, 12000, 148),
        (47.16, -2.48, 18000, 136),
        (45.02, -0.88, 22000, 128),
        (43.88, 1.05, 18000, 120),
    ],
    "TOP114": [
        (45.72, 4.94, 9000, 224),
        (45.33, 2.25, 14000, 242),
        (44.78, 1.12, 15000, 262),
        (44.94, 3.78, 13000, 72),
    ],
}


def interpolate(track, step, total_steps):
    position = (step % total_steps) / total_steps
    scaled = position * (len(track) - 1)
    index = int(math.floor(scaled))
    ratio = scaled - index
    start = track[index]
    end = track[min(index + 1, len(track) - 1)]
    return tuple(start[i] + (end[i] - start[i]) * ratio for i in range(4))


def push_position(base_url, token, callsign, flight_no, position):
    latitude, longitude, altitude, heading = position
    payload = json.dumps({
        "latitude": round(latitude, 4),
        "longitude": round(longitude, 4),
        "altitude": round(altitude),
        "heading": round(heading),
        "speed": max(180, min(470, round(220 + altitude / 145))),
        "verticalRate": 0,
        "status": "ENROUTE",
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/flights/{flight_no}/position",
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
            "x-operator": callsign,
            "user-agent": "airops-position-agent/0.1",
        },
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    parser = argparse.ArgumentParser(description="Simule l'avancee des avions AirOps.")
    parser.add_argument("--base-url", default="http://127.0.0.1:30080", help="URL publique de l'application")
    parser.add_argument("--token", default="bWF2ZXJpY2s6YWRtaW46YWlyLW9wcy1hZG1pbg==", help="Bearer token faible du lab")
    parser.add_argument("--callsign", default="telemetry-agent", help="Valeur x-operator envoyee a l'API")
    parser.add_argument("--interval", type=float, default=2.0, help="Delai entre deux pushes")
    parser.add_argument("--steps", type=int, default=80, help="Nombre de pas par boucle complete")
    parser.add_argument("--once", action="store_true", help="Envoie une seule position par avion puis s'arrete")
    args = parser.parse_args()

    step = 0
    while True:
        for flight_no, track in TRACKS.items():
            try:
                result = push_position(args.base_url, args.token, args.callsign, flight_no, interpolate(track, step, args.steps))
                flight = result["flight"]
                print(f"{flight_no}: {flight['latitude']:.4f},{flight['longitude']:.4f} {flight['altitude']}ft hdg {flight['heading']}")
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, KeyError) as error:
                print(f"{flight_no}: push failed: {error}")
        if args.once:
            break
        step += 1
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
