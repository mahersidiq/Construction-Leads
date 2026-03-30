import { useState } from "react";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";

export default function App() {
  const [authenticated, setAuthenticated] = useState(
    () => localStorage.getItem("cl_auth") === "true",
  );

  const handleLogin = () => {
    localStorage.setItem("cl_auth", "true");
    setAuthenticated(true);
  };

  const handleLogout = () => {
    localStorage.removeItem("cl_auth");
    setAuthenticated(false);
  };

  if (!authenticated) {
    return <Login onLogin={handleLogin} />;
  }

  return <Dashboard onLogout={handleLogout} />;
}
