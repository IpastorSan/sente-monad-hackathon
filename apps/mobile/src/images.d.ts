/** Metro turns an imported image into an asset source (SEN-214, token logos). */
declare module '*.png' {
  const source: import('react-native').ImageSourcePropType;
  export default source;
}
