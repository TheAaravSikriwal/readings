import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/newsreader';
import './styles.css';
import App from './App';
import { actions } from './store';

actions.load();
createRoot(document.getElementById('root')!).render(<App />);
