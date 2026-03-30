import { useState, Component } from "react";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Upload from "./pages/Upload";

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="bg-white p-8 rounded-lg shadow max-w-lg text-center">
            <h2 className="text-lg font-bold text-red-600 mb-2">Something went wrong</h2>
            <p className="text-sm text-gray-600 mb-4">{this.state.error?.message}</p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(
    () => localStorage.getItem("cl_auth") === "true",
  );
  const [page, setPage] = useState("dashboard");

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

  if (page === "upload") {
    return (
      <ErrorBoundary>
        <div className="min-h-screen bg-gray-50">
          <header className="bg-white shadow-sm border-b border-gray-200">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
              <div>
                <h1 className="text-xl font-bold text-gray-900">
                  Construction Leads
                </h1>
                <p className="text-xs text-gray-500">Saadi Construction Group</p>
              </div>
              <button
                onClick={() => setPage("dashboard")}
                className="text-sm text-blue-600 hover:text-blue-800 transition-colors font-medium"
              >
                Back to Dashboard
              </button>
            </div>
          </header>
          <Upload onDone={() => setPage("dashboard")} />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <Dashboard
        onLogout={handleLogout}
        onUpload={() => setPage("upload")}
      />
    </ErrorBoundary>
  );
}
