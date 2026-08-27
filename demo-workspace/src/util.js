function slug(str) {
  return str.replace(/ /g, '-');
}

module.exports = { slug };
