# Aurora

Aurora is a local desktop AI assistant with a React/Electron interface and a
FastAPI backend. It can connect to a local or hosted language model, speak
responses with Piper, transcribe microphone input with sherpa-onnx, and run
approved tools or scripts.

## Start Aurora

Install the JavaScript dependencies in both application directories, then
start Electron:

```bash
cd frontend
npm install

cd ../electron
npm install
npm start
```

`npm start` builds the frontend, starts the backend on
`http://127.0.0.1:8765`, and opens the Electron window. See
[`electron/README.md`](electron/README.md) for systemd autostart instructions.

The backend requires Python 3 with `fastapi`, `uvicorn`, and `httpx`. Voice
input additionally requires `numpy` and `sherpa-onnx`. Voice output requires
either the `piper-tts` Python package or a `piper` executable; set `PIPER_BIN`
if that executable is not on `PATH`.

## Start Aurora automatically at login

On a Linux desktop using systemd, run the user-service installer from the
repository root:

```bash
./electron/systemd/install.sh
```

The installer resolves the clone's actual location, installs the npm
dependencies, builds the frontend, creates
`~/.config/systemd/user/aurora.service`, and runs:

```bash
systemctl --user daemon-reload
systemctl --user enable --now aurora.service
```

This is a per-user graphical service, so do not run the installer with `sudo`.
Check it with `systemctl --user status aurora.service` and follow logs with
`journalctl --user -u aurora.service -f`. Remove autostart with:

```bash
./electron/systemd/uninstall.sh
```

## Configure a language model

Open **Settings** in Aurora and configure these fields:

1. **Model server address** — the base URL of the model server.
2. **Server type** — `OpenAI-compatible` or `Ollama`.
3. **API key** — required by most hosted providers; normally blank for local
   servers.
4. **Model name** — the exact model ID exposed by the server.
5. Select **Test connection**, choose a returned model, then select
   **Save settings**.

The test requests the server's model-list endpoint. A server may still work if
it does not provide a list: type its model ID manually.

### Endpoint examples

| Server | Server type | Model server address | Model name |
| --- | --- | --- | --- |
| llama.cpp | OpenAI-compatible | `http://127.0.0.1:8080` | Optional when the server has one loaded model |
| LM Studio | OpenAI-compatible | `http://127.0.0.1:1234/v1` | Exact loaded model ID |
| Ollama | Ollama | `http://127.0.0.1:11434` | Exact Ollama tag, such as `name:tag` |
| OpenAI | OpenAI-compatible | `https://api.openai.com/v1` | A chat-capable model ID available to the API key |
| OpenRouter | OpenAI-compatible | `https://openrouter.ai/api/v1` | Provider/model ID returned by the endpoint |
| Groq | OpenAI-compatible | `https://api.groq.com` | Model ID returned by the endpoint |
| Gemini OpenAI compatibility | OpenAI-compatible | `https://generativelanguage.googleapis.com/v1beta/openai` | Model ID returned by the endpoint |

For an OpenAI-compatible server, Aurora accepts any of these URL forms:

- A server root such as `http://127.0.0.1:8080`. Aurora adds `/v1`.
- A versioned base such as `https://host.example/v1`.
- An OpenAI compatibility base ending in `/openai`.
- A complete URL ending in `/chat/completions`.

Aurora calls `/v1/models` and `/v1/chat/completions` where appropriate. Ollama
uses `/api/tags` and `/api/chat` instead.

### Which LLM model type should I use?

Use a **text chat or instruction model** that supports multi-message chat.
Aurora sends `system`, `user`, and `assistant` messages and consumes a streamed
response.

- OpenAI-compatible models must support streamed Chat Completions.
- Ollama models must support its chat API.
- Reasoning models may expose reasoning text separately; Aurora understands
  common `reasoning` and `reasoning_content` fields.
- Embedding-only, image-generation, reranking, and base completion models are
  not suitable.
- Aurora currently sends text, not image or audio input, to the LLM.

The **Thinking** setting can be Off, Auto, or Always. For local
OpenAI-compatible servers, Aurora sends llama.cpp's
`chat_template_kwargs.enable_thinking`. For Ollama it sends `think`. Hosted
providers receive neither provider-specific field.

Temperature and top-p are in **Controls**. Choose the server-default option if
a hosted reasoning model rejects sampling parameters.

### API keys and environment variables

The UI stores a saved API key in `~/.config/aurora/settings.json`, sets the file
mode to `0600`, and never returns the key to the frontend. You may provide
configuration through environment variables instead:

| Variable | Purpose | Default |
| --- | --- | --- |
| `LLM_URL` | Model server address | `http://127.0.0.1:8080` |
| `OLLAMA_URL` | Fallback server address when `LLM_URL` is unset | — |
| `LLM_API` | `openai` or `ollama` | `openai` |
| `LLM_API_KEY` | Hosted-provider API key | — |
| `OPENAI_API_KEY` | Fallback API key | — |
| `AURORA_MODEL` | Model ID | — |
| `MODEL_NAME` | Fallback model ID | — |

Saved UI settings take precedence after they have been written.

## Text-to-speech (TTS)

Aurora uses **Piper ONNX voice models** locally. It does not currently call a
cloud TTS endpoint.

Each voice needs two files in the model directory:

```text
voice-name.onnx
voice-name.onnx.json
```

By default Aurora scans `/home/kelvin/projects/ai/model/`. Override that
directory with `AURORA_MODELS`, or point directly to a voice with
`TTS_MODEL_PATH`:

```bash
export AURORA_MODELS=/path/to/aurora-models
export TTS_MODEL_PATH=/path/to/aurora-models/en_US-voice-medium.onnx
```

Restart Aurora after changing model environment variables. The **Voice** list
in Settings shows every `.onnx` file that has a matching `.onnx.json` file.
You can also enable or disable spoken replies and adjust speaking speed there.

TTS model quality names such as `low`, `medium`, and `high` refer to Piper
voice sizes. They are voice models, not language models.

## Speech-to-text (STT)

Aurora performs speech recognition locally with **sherpa-onnx**. Set
`SHERPA_KIND` to one of the two supported model types.

### Parakeet TDT (default)

```bash
export SHERPA_KIND=parakeet_tdt
export PARAKEET_DIR=/path/to/parakeet
```

The directory must contain:

```text
encoder.int8.onnx
decoder.int8.onnx
joiner.int8.onnx
tokens.txt
```

### NeMo CTC

```bash
export SHERPA_KIND=nemo_ctc
export SHERPA_MODEL=/path/to/sherpa/model.int8.onnx
export SHERPA_TOKENS=/path/to/sherpa/tokens.txt
```

Both recognizers expect 16 kHz mono audio. `ASR_THREADS` controls recognition
threads and defaults to `4`.

Live listening also requires a **Silero VAD** ONNX model. By default Aurora
looks for `silero_vad.onnx` inside `AURORA_MODELS`; override it with:

```bash
export VAD_MODEL=/path/to/silero_vad.onnx
```

The VAD model detects when speech ends; it does not transcribe speech. In
Settings, **Live listening pause before send** controls how much silence ends
an utterance, and **Maximum continuous live utterance** limits its length.

If an STT dependency or model file is missing, Aurora still starts and shows
the microphone controls as unavailable with the relevant error.

## Configuration files

Aurora keeps local state outside the repository:

| Path | Contents |
| --- | --- |
| `~/.config/aurora/settings.json` | Model, voice, and behavior settings |
| `~/.config/aurora/mcp.json` | MCP server definitions |
| `~/.config/aurora/skills.json` | Saved prompt skills |
| `~/.local/share/aurora/history.db` | Conversation history and memory |

## Common connection errors

- **Could not reach that address** — the URL, port, server process, or network
  connection is wrong.
- **401** — the API key was rejected.
- **403** — the key does not have access to the requested service or model.
- **404** — the base URL or model name is wrong.
- **429** — the hosted account is rate-limited or out of credit.
- **Connected but no models found** — type the exact model ID manually and
  save; some compatible servers do not implement model listing.
