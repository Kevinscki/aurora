import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyOpacity, getOpacity } from "./prefs";

// The desktop shell loads the page with ?shell=1 and a transparent window.
// In a normal browser tab we paint a backdrop so the island is visible.
const params = new URLSearchParams(location.search);
if (!params.has("shell")) document.documentElement.classList.add("dev");
if (params.has("nativeBlur")) document.documentElement.classList.add("native-blur");

applyOpacity(getOpacity()); // remembered window transparency

createRoot(document.getElementById("root")).render(<App />);
