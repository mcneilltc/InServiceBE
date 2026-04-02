const errorHandler = (err, req, res, next) => {
  console.error(err.stack); // For server-side logging

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    error: {
      message: message,
      // Stack traces should be hidden in production, but let's include for development
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
    }
  });
};

module.exports = errorHandler;
