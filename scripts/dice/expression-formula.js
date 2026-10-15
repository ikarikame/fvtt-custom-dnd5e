const LIMITS = Object.freeze({ length: 512, depth: 16, tokens: 128, dice: 50, faces: 1000, constant: 1000000 });

/**
 * Restrict user input before handing syntax and evaluation to Foundry's native parser.
 * This scans tokens only; it does not interpret arithmetic or replace the dice parser.
 * @param {string} value
 * @param {typeof Roll} [RollClass=foundry.dice.Roll]
 * @returns {string} Validated, trimmed expression
 */
export function validateExpressionFormula(value, RollClass = foundry.dice.Roll) {
  if ( typeof value !== "string" ) throw new Error("The expression must be text.");
  const formula = value.trim();
  if ( !formula || formula.length > LIMITS.length ) throw new Error("Use an expression of 1 to 512 characters.");
  if ( /\*\*|\/\//.test(formula) ) throw new Error("Only +, -, *, / and parentheses are supported.");

  const token = /\s*(\d+[dD]\d+(?:(?:kh|kl)\d*)?|\d+(?:\.\d+)?|[()+\-*/])/y;
  let position = 0;
  let depth = 0;
  let count = 0;
  let dice = 0;
  while ( position < formula.length ) {
    token.lastIndex = position;
    const match = token.exec(formula);
    if ( !match ) throw new Error(`Unsupported expression syntax at character ${position + 1}.`);
    position = token.lastIndex;
    if ( ++count > LIMITS.tokens ) throw new Error("The expression has too many terms.");
    const text = match[1];
    if ( text === "(" && ++depth > LIMITS.depth ) throw new Error("The expression is nested too deeply.");
    if ( text === ")" && --depth < 0 ) throw new Error("Unbalanced parentheses.");
    const die = /^(\d+)[dD](\d+)(?:(kh|kl)(\d*))?$/.exec(text);
    if ( die ) {
      const number = Number(die[1]);
      const faces = Number(die[2]);
      dice += number;
      if ( number < 1 || dice > LIMITS.dice || faces < 2 || faces > LIMITS.faces ) {
        throw new Error("Use at most 50 dice, with 2 to 1000 faces each.");
      }
      if ( die[3] && (Number(die[4] || 1) < 1 || Number(die[4] || 1) > number) ) {
        throw new Error("Keep between one and the number of dice rolled.");
      }
    } else if ( /^\d/.test(text) && Number(text) > LIMITS.constant ) {
      throw new Error("Constants must not exceed 1000000.");
    }
  }
  if ( depth !== 0 ) throw new Error("Unbalanced parentheses.");
  if ( dice === 0 ) throw new Error("The expression must contain at least one die.");
  if ( !RollClass.validate(formula) ) throw new Error("Foundry could not parse this expression.");
  return formula;
}
