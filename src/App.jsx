import { useEffect } from "react";
import Game from "./game.jsx";
import GameMobile from "./GameMobile.tsx"; // <-- NUEVO
import { Routes, Route, Navigate } from "react-router-dom";

export default function App() {
  useEffect(() => {
    document.body.style.margin = "0";
    document.body.style.background = "#000";
  }, []);

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        display: "grid",
        placeItems: "center",
        background: "#000",
      }}
    >
      <Routes>
        <Route path="/pc" element={<Game />} />
        <Route path="/mobile" element={<GameMobile />} />
        {/* opcional: si entran a /, redirigí a /pc o armá un landing */}
        <Route path="/" element={<Navigate to="/pc" replace />} />
        {/* catch-all por si se pisan rutas */}
        <Route path="*" element={<Navigate to="/pc" replace />} />
      </Routes>
    </div>
  );
}
