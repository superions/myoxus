// oxlint-disable-next-line typescript/ban-ts-comment
// @ts-nocheck

Promise.withResolvers ??= function withResolvers() {
  let a,
    b,
    c = new this(function (resolve, reject) {
      a = resolve;
      b = reject;
    });
  return { resolve: a, reject: b, promise: c };
};
