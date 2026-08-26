import globals from "globals";
import pluginJs from "@eslint/js";

export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node, // Вказуємо, що код працює в середовищі Node.js (process, __dirname і т.д.)
      },
      sourceType: "commonjs", // Вказуємо використання require/module.exports
    },
  },
  pluginJs.configs.recommended,
  {
    rules: {
      "no-unused-vars": "warn", // Невикористані змінні будуть попередженням, а не критичною помилкою
      "no-undef": "error",       // Використання нее оголошених змінних — помилка
    },
  },
];