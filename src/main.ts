import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { admin } from "./store";
import "./styles/app.css";

admin.load();
createApp(App).use(router).mount("#app");
