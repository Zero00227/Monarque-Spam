// En local, charge un fichier .env si présent (sans effet sur Vercel,
// qui injecte les variables d'environnement lui-même).
try { require('dotenv').config(); } catch (e) { /* dotenv non installé : ok en prod */ }

const express = require('express');
const app = express();

app.set('trust proxy', true);
app.use(express.json());

const setupApiRoutes = require('./api-routes');
setupApiRoutes(app);

module.exports = app;
