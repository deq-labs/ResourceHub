import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

function App() {
  return (
    <main className="grid min-h-screen place-items-center">
      <h1 className="text-3xl font-semibold">ResourceHub</h1>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
