import { useEffect } from "react";
import Game from "./game.jsx";

export default function App() {
  useEffect(() => {
    document.body.style.margin = "0";
    document.body.style.background = "#000"; // fondo negro
  }, []);

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        display: "grid",
        placeItems: "center",
        background: "#000", // también aquí
      }}
    >
      <Game />
    </div>
  );
}
