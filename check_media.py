import subprocess
import json

def get_mpris_players():
    try:
        # List all services on the session bus
        cmd = ["dbus-send", "--session", "--dest=org.freedesktop.DBus", "--type=method_call", "--print-reply", "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        players = []
        for line in result.stdout.split('\n'):
            if "org.mpris.MediaPlayer2" in line:
                # Extract the service name
                service = line.split('"')[-2] if '"' in line else line.strip()
                players.append(service)
        return players
    except Exception as e:
        return str(e)

players = get_mpris_players()
if isinstance(players, list) and players:
    print(f"Found active media players: {', '.join(players)}")
elif isinstance(players, list):
    print("No MPRIS-compatible media players found.")
else:
    print(f"Error: {players}")
