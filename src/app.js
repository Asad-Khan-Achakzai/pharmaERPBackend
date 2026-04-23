const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const corsOptions = require('./config/cors');
const errorHandler = require('./middleware/errorHandler');
const ApiError = require('./utils/ApiError');
const routes = require('./routes/v1');

const app = express();

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

app.use('/invoices', express.static(path.join(__dirname, '../invoices')));

app.use('/api/v1', routes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((_req, _res, next) => {
  next(new ApiError(404, 'Route not found'));
});

app.use(errorHandler);

module.exports = app;
