import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Stage0SpikeApp } from './spike/Stage0SpikeApp';
import './styles/globals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Stage0SpikeApp />
  </StrictMode>
);
