// @ts-check
// Façade du dialecte FCP7 XML. LECTURE SEULE : NetsuRush n'écrit jamais de XML, il se contente
// d'extraire d'un export d'hôte ce que l'API de script ne sait pas rendre (images clés, vitesse).

const { parseXmeml, localPath } = require("./parse");

module.exports = { parseXmeml, localPath };
