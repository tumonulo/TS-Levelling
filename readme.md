# TS-Levelling

Bot de niveles para Discord desarrollado y adaptado para **TSCommunity** a partir de [Polaris Open](https://github.com/GDColon/Polaris-Open).

## ✨ Características

* 📈 Sistema de experiencia y niveles basado en la actividad del servidor.
* 🏆 Rangos competitivos inspirados en Brawl Stars mediante roles de Discord.
* 🎨 Tarjetas de `/rank` personalizadas para TSCommunity.
* 📊 Clasificación del servidor mediante `/top`.
* ⭐ Sistema especial para el rango máximo Pro.
* ⚙️ Configuración y gestión del sistema directamente desde Discord.
* 🗄️ Persistencia de datos mediante MongoDB.

## 🏆 Rangos

🥉 **Bronce I, II y III**
🥈 **Plata I, II y III**
🥇 **Oro I, II y III**
💎 **Diamante I, II y III**
🔮 **Mítico I, II y III**
🏆 **Legendario I, II y III**
👑 **Maestro I, II y III**
⭐ **Pro**

Cada rango se obtiene al alcanzar el nivel configurado para su rol dentro del servidor.

## 📊 Sistema de rangos

La experiencia se obtiene mediante la actividad del servidor. Al alcanzar determinados niveles, el usuario recibe el rol correspondiente a su rango competitivo.

El comando `/rank` muestra el rango, nivel, experiencia, mensajes, posición en la clasificación y progreso hacia el siguiente rango.

![Rango Mítico](./assets/showcase/rank-mythic.webp)

Mientras el usuario puede seguir progresando, la tarjeta muestra cuánto le falta para alcanzar el siguiente rango.

Al llegar a **Pro**, el rango máximo, la tarjeta cambia automáticamente para mostrar cuánto le falta para adelantar al siguiente usuario de la clasificación.

![Rango Pro](./assets/showcase/rank-pro.webp)

## 🛠️ Tecnologías

* JavaScript
* Node.js
* Discord.js
* MongoDB
* Mongoose

## 📚 Origen

Proyecto basado en [Polaris Open](https://github.com/GDColon/Polaris-Open), posteriormente adaptado y personalizado para TSCommunity.

## 📌 Estado

🟡 **Proyecto no terminado · actualmente no está en uso**

El desarrollo queda actualmente detenido, aunque el proyecto puede retomarse en el futuro.