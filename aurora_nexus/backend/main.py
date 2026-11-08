from fastapi import FastAPI, WebSocket, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
import uvicorn
import psutil
import datetime

app = FastAPI()

# Setup frontend paths
app.mount("/static", StaticFiles(directory="aurora_nexus/frontend/static"), name="static")
templates = Jinja2Templates(directory="aurora_nexus/frontend/templates")

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/system")
async def get_system_stats():
    return {
        "cpu": psutil.cpu_percent(),
        "ram": psutil.virtual_memory().percent,
        "time": datetime.datetime.now().strftime("%H:%M:%S")
    }

@app.websocket("/ws/chat")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    while True:
        data = await websocket.receive_text()
        # This is where the AI logic will plug in during Sprint 3
        response = f"Nexus received: {data}. (AI Brain coming in Sprint 3)"
        await websocket.send_text(response)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765)
