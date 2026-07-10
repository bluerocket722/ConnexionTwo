{
  "name": "connexiontwo-scanner",
  "version": "1.0.0",
  "description": "Connexion Two — internal ClamAV malware-scanning service",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "node server.js"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "express": "^4.19.2",
    "multer": "^1.4.5-lts.1",
    "clamscan": "^2.4.0"
  }
}
