function isoNow() {
  return new Date().toISOString();
}

function serverTimestamp(admin) {
  return admin.firestore.FieldValue.serverTimestamp();
}

module.exports = {
  isoNow,
  serverTimestamp
};
