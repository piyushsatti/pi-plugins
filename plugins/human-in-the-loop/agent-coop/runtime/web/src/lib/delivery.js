// The delivery-class control, built once and shared by both composers
// (ui-design §Selection-comment layer: "a small inline segmented control on
// the comment composer, not a modal"). Selection comments and global comments
// carry the same three classes, so they carry the same control — one unit, two
// consumers, no second copy to drift.
//
// Segmented control = a radio group, not a <select>: radios are the native
// semantics for "one of N, all visible", they are keyboard-reachable with
// arrow keys for free, and they let `interrupt` carry its own affordance
// (ui-design: "interrupt gets a distinct affordance") instead of being one
// indistinguishable line in a dropdown.
import { DELIVERY_MODES } from "../contract.gen.js";
import { DELIVERY_DEFAULT, DELIVERY_INTERRUPT } from "./enums.js";

// The SET of classes is the contract's, so it is DERIVED from it rather than
// retyped (B2/CQ5): a fourth delivery class in src/contract used to mean a class
// the user could never choose, with nothing to say so. Only the ORDER is a UI
// decision — the default reads first, `interrupt` next — and ordering cannot drop
// a value, because the rest of the contract's list follows.
const FIRST = [DELIVERY_DEFAULT, DELIVERY_INTERRUPT];
export const DELIVERY_CLASSES = [...FIRST, ...DELIVERY_MODES.filter((v) => !FIRST.includes(v))];
export const DEFAULT_DELIVERY = DELIVERY_DEFAULT;

/** `interrupt` is the only class with a marker; the others read as plain text. */
const AFFORDANCE = { [DELIVERY_INTERRUPT]: "⚑" };

let seq = 0;

/**
 * @param {string} label — visible legend, distinct per composer for screen readers
 * @returns {HTMLFieldSetElement} with `.value` readable via deliveryOf()
 */
export function deliveryControl(label = "Delivery") {
  const name = `delivery-${++seq}`;
  const fs = document.createElement("fieldset");
  fs.className = "delivery";
  fs.dataset.deliveryControl = "";

  const legend = document.createElement("legend");
  legend.textContent = label;
  fs.appendChild(legend);

  for (const value of DELIVERY_CLASSES) {
    const wrap = document.createElement("label");
    wrap.className = `delivery-option delivery-${value}`;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = value;
    input.checked = value === DEFAULT_DELIVERY;
    const text = document.createElement("span");
    text.textContent = AFFORDANCE[value] ? `${AFFORDANCE[value]} ${value}` : value;
    wrap.append(input, text);
    fs.appendChild(wrap);
  }
  return fs;
}

/** The selected class inside a container holding exactly one control. */
export function deliveryOf(root) {
  const checked = root.querySelector("[data-delivery-control] input:checked");
  return checked === null ? DEFAULT_DELIVERY : checked.value;
}

/** Reset to the default after a successful post. */
export function resetDelivery(root) {
  for (const input of root.querySelectorAll("[data-delivery-control] input")) {
    input.checked = input.value === DEFAULT_DELIVERY;
  }
}
