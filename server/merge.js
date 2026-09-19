/* merge.js — the server uses the browser's js/merge.js as is.
 *
 * Client and server must resolve every conflict identically, or two people editing
 * the same note never converge. There used to be two hand-synced copies of the
 * merge; now there is one, and this file only re-exports it. See js/merge.js.
 */
'use strict';

module.exports = require('../js/merge.js');
