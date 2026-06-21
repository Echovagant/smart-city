<template>
  <div id="app">
    <SmartCity />
  </div>
</template>

<script setup>
import SmartCity from './components/SmartCity.vue'
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Arial', sans-serif;
  overflow: hidden;
}

#app {
  width: 100vw;
  height: 100vh;
}
</style>
