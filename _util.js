function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data || "{}"));
    req.on("error", reject);
  });
}

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured on this deployment.`);
  return v;
}

module.exports = { readBody, env };
