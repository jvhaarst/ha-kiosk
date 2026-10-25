#!/usr/bin/env python3
"""Build and push the kiosk dashboard config.

This file is the source of truth for the dashboard's layout. Editing the
dashboard in the Home Assistant UI works, but the next run of this script
overwrites it, so make layout changes here and entity changes in the
environment.

Everything site-specific comes from environment variables; see
kiosk.env.example for the full list and for what the defaults are worth. It
only ever writes the one dashboard named by KIOSK_DASHBOARD. Any other
dashboard is left alone.

Usage:
    set -a; . ./kiosk.env; set +a
    python3 tools/build-dashboard.py [--print]
"""

import json
import os
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
WS_CLIENT = HERE / "ha_ws.py"

URL_PATH = os.environ.get("KIOSK_DASHBOARD", "kiosk-flow")


def entities(name, default=""):
    """A comma-separated list of entity ids, blanks dropped."""
    raw = os.environ.get(name, default)
    return [part.strip() for part in raw.split(",") if part.strip()]


def labelled(name, default=""):
    """A comma-separated list of `entity=Label` pairs.

    A bare entity with no `=` keeps whatever name Home Assistant gives it,
    which is usually what you want until it is not.
    """
    out = []
    for part in entities(name, default):
        entity, _, label = part.partition("=")
        out.append((entity.strip(), label.strip() or None))
    return out


def power_group(prefix, fallback_name):
    """One box on the power-flow screen.

    Returns None when nothing is configured for it, so a system with no EV
    charger or no solar simply has one fewer box rather than an empty one.
    """
    entity = os.environ.get(f"{prefix}_ENTITY", "").strip()
    phases = entities(f"{prefix}_PHASES")
    if not entity and not phases:
        return None
    group = {"name": os.environ.get(f"{prefix}_NAME", fallback_name)}
    if entity:
        group["entity"] = entity
    if phases:
        group["phases"] = phases
    return group


# Turning this entity on sends whichever screen is showing to the doorbell.
# Use the button-press sensor rather than a motion sensor, or passers-by take
# over the panel.
ALERT = {
    "entity": os.environ.get("ALERT_ENTITY", "binary_sensor.doorbell_visitor"),
    "to": "on",
    "path": f"/{URL_PATH}/deurbel",
}

# After this long with nobody touching the panel, any screen returns to the
# first one, so the kiosk is always found showing the same thing. The countdown
# does not run while that screen is already showing.
IDLE_RETURN = {
    "seconds": int(os.environ.get("IDLE_SECONDS", "120")),
    "path": f"/{URL_PATH}/stroom",
}

NAV = [
    {"name": "Stroom", "icon": "mdi:transmission-tower", "path": f"/{URL_PATH}/stroom"},
    {"name": "Lampen", "icon": "mdi:lightbulb-group", "path": f"/{URL_PATH}/lampen"},
    {"name": "CV&Airco", "icon": "mdi:thermostat", "path": f"/{URL_PATH}/cv-airco"},
    {"name": "Deurbel", "icon": "mdi:doorbell-video", "path": f"/{URL_PATH}/deurbel"},
    {"name": "Afval", "icon": "mdi:trash-can", "path": f"/{URL_PATH}/afval"},
]


def stroom():
    card = {"type": "custom:power-flow-card"}
    for key, prefix, fallback in [
        ("grid", "GRID", "Net"),
        ("solar", "SOLAR", "Zon"),
        ("loads", "LOADS", "AC Belastingen"),
        ("ev", "EV", "Laadpaal"),
    ]:
        group = power_group(prefix, fallback)
        if group:
            card[key] = group
    return card


def lampen():
    # A tile's `features` put the control on the card itself, so a light can be
    # dimmed or switched without first opening its dialog. Lights get a
    # brightness slider as well; a switch has nothing to dim. The toggle comes
    # last everywhere, so it is in the same place on every tile.
    cards = []
    for entity, label in labelled(
        "LIGHT_ENTITIES",
        "light.living_room=Woonkamer,light.hallway=Hal,switch.outdoor_lights=Buitenverlichting",
    ):
        features = [{"type": "toggle"}]
        if entity.startswith("light."):
            features.insert(0, {"type": "light-brightness"})
        card = {"type": "tile", "entity": entity, "features": features}
        if label:
            card["name"] = label
        cards.append(card)
    return {"type": "grid", "columns": 1, "square": False, "cards": cards}


def cv_airco():
    cards = []
    for entity, label in labelled(
        "CLIMATE_ENTITIES",
        "climate.thermostat=Thermostaat,climate.upstairs=Boven,climate.living_room=Woonkamer",
    ):
        card = {"type": "tile", "entity": entity, "vertical": True}
        if label:
            card["name"] = label
        cards.append(card)
    return {"type": "grid", "columns": 2, "square": False, "cards": cards}


def deurbel():
    sensors = labelled(
        "DOORBELL_SENSORS",
        "binary_sensor.doorbell_visitor=Bezoek,"
        "binary_sensor.doorbell_person=Persoon,"
        "binary_sensor.doorbell_motion=Beweging",
    )
    return {
        "type": "vertical-stack",
        "cards": [
            # A doorbell camera is usually about 4:3, which at 720px wide is
            # some 533px tall; with the sensor row under it that overran the
            # space above the navigation buttons and pushed them off the panel.
            # 3:2 crops little and still leaves the buttons their room.
            {
                "type": "picture-entity",
                "entity": os.environ.get("DOORBELL_CAMERA", "camera.doorbell"),
                "camera_view": "auto",
                "aspect_ratio": "3:2",
                "show_state": False,
                "show_name": False,
            },
            {
                "type": "glance",
                "columns": 3,
                "entities": [
                    {"entity": entity, "name": label} if label else {"entity": entity}
                    for entity, label in sensors
                ],
            },
        ],
    }


def afval():
    """Waste collection, drawn by the trash-card HACS plugin.

    This mirrors the configuration the user already runs on their own Thuis
    dashboard, so the kiosk shows the same thing in the same style rather than
    a second opinion. The compactness comes from `card_style: icon` together
    with `event_grouping`, which collapses the run of future dates down to the
    next pickup; `next_days` only bounds how far ahead it will look.

    `pattern` matches on the calendar event titles, so these strings have to be
    exactly what the collector publishes. The four here are the usual Dutch
    streams, with a catch-all last entry for anything else; set TRASH_CALENDAR
    to your own calendar entity.
    """
    return {
        "type": "custom:trash-card",
        "entities": [os.environ.get("TRASH_CALENDAR", "calendar.waste_collection")],
        "card_style": "icon",
        "layout": "vertical",
        "alignment_style": "left",
        "color_mode": "background",
        "day_style": "counter",
        "day_style_format": "yyyy.MM.dd",
        "event_grouping": True,
        # A bin put out this morning is no longer news by the afternoon.
        "drop_todayevents_from": "12:00:00",
        "icon_size": int(os.environ.get("TRASH_ICON_SIZE", "210")),
        "items_per_row": 2,
        "with_label": True,
        "refresh_rate": 60,
        "next_days": 60,
        "filter_events": False,
        "use_summary": False,
        "hide_time_range": False,
        "pattern": [
            {
                "type": "GFT",
                "label": "GFT",
                "icon": "mdi:flower",
                "color": "light-green",
                "pattern": "GFT",
            },
            {
                "type": "paper",
                "label": "Papier",
                "icon": "mdi:newspaper-variant-multiple-outline",
                "color": "indigo",
                "pattern": "Papier",
            },
            {
                "type": "recycle",
                "label": "PMD",
                "icon": "mdi:trash-can-outline",
                "color": "orange",
                "pattern": "pmd",
            },
            {
                "type": "waste",
                "label": "Restafval",
                "icon": "mdi:trash-can",
                "color": "dark-grey",
                "pattern": "Restafval",
            },
            {"type": "others", "icon": "mdi:dump-truck", "color": "green"},
        ],
    }


# Stylesheets pushed into a wrapped card's shadow root, keyed by view path.
# See _injectCss in kiosk-shell-card.js for why this is sometimes the only way.
CARD_CSS = {
    # The trash card's icon style hardcodes four fixed columns and ignores its
    # own items_per_row, so it draws a thin strip across the top of the panel.
    # Two columns of equal height fill the screen instead.
    "afval": """
.icons-container {
  grid-template-columns: 1fr 1fr !important;
  grid-auto-rows: 1fr !important;
  height: 100% !important;
  gap: 10px !important;
}
.icons-container > ha-card { height: 100% !important; }
""",
}


SCREENS = [
    ("Stroom", "stroom", "mdi:transmission-tower", stroom),
    ("Lampen", "lampen", "mdi:lightbulb-group", lampen),
    ("CV&Airco", "cv-airco", "mdi:thermostat", cv_airco),
    ("Deurbel", "deurbel", "mdi:doorbell-video", deurbel),
    ("Afval", "afval", "mdi:trash-can", afval),
]


def build():
    views = [
        {
            "title": title,
            "path": path,
            "icon": icon,
            "type": "panel",
            # Every screen is wrapped in the shell, so the navigation buttons
            # sit in the same place on all of them.
            "cards": [
                {
                    "type": "custom:kiosk-shell-card",
                    "nav": NAV,
                    "alert": ALERT,
                    "idle_return": IDLE_RETURN,
                    "card": content(),
                    **({"card_css": CARD_CSS[path]} if path in CARD_CSS else {}),
                }
            ],
        }
        for title, path, icon, content in SCREENS
    ]
    return {
        "kiosk_mode": {"hide_header": True, "hide_sidebar": True},
        "views": views,
    }


def main():
    config = build()
    if "--print" in sys.argv:
        print(json.dumps(config, indent=2))
        return 0

    if not os.environ.get("HA_TOKEN"):
        print("set HA_TOKEN to a Home Assistant long-lived access token", file=sys.stderr)
        return 2
    os.environ.setdefault("HA_WS_URL", "wss://homeassistant.example.net/api/websocket")

    command = [{"type": "lovelace/config/save", "url_path": URL_PATH, "config": config}]
    result = subprocess.run(
        [sys.executable, "-I", str(WS_CLIENT)],
        input=json.dumps(command),
        capture_output=True,
        text=True,
    )
    sys.stderr.write(result.stderr)
    if result.returncode != 0:
        return result.returncode
    for line in result.stdout.splitlines():
        if line.startswith("{"):
            reply = json.loads(line)
            print(f"saved {URL_PATH}" if reply.get("ok") else f"FAILED: {reply.get('error')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
