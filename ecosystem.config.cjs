module.exports = {
  apps: [
    {
      name: "cfapi-api",
      script: "dist/server.js",
      env: { NODE_ENV: "production" }
    },
    {
      name: "cfapi-worker",
      script: "dist/worker.js",
      env: { NODE_ENV: "production" }
    }
  ]
};
