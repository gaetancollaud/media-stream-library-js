const {Readable, Writable} = require('stream')

const Component = require('../component')
const {SDP, JPEG} = require('../messageTypes')
const Clock = require('../../utils/clock')
const Scheduler = require('../../utils/scheduler')

const resetInfo = (info) => {
  info.bitrate = 0
  info.framerate = 0
}

const generateUpdateInfo = (clockrate) => {
  let cumulativeByteLength = 0
  let cumulativeDuration = 0
  let cumulativeFrames = 0

  return (info, {byteLength, duration}) => {
    cumulativeByteLength += byteLength
    cumulativeDuration += duration
    cumulativeFrames++

    // Update the cumulative number size (bytes) and duration (ticks), and if
    // the duration exceeds the clockrate (meaning longer than 1 second of info),
    // then compute a new bitrate and reset cumulative size and duration.
    if (cumulativeDuration >= clockrate) {
      const bits = 8 * cumulativeByteLength
      const frames = cumulativeFrames
      const seconds = cumulativeDuration / clockrate
      info.bitrate = bits / seconds
      info.framerate = frames / seconds
      cumulativeByteLength = 0
      cumulativeDuration = 0
      cumulativeFrames = 0
    }
  }
}

/**
 * Canvas component
 *
 * Draws an incoming stream of JPEG images onto a <canvas> element.
 * The RTP timestamps are used to schedule the drawing of the images.
 * An instance can be used as a 'clock' itself, e.g. with a scheduler.
 *
 * The following handlers can be set on a component instance:
 *  - onCanplay: will be called when the first frame is ready and
 *               the correct frame size has been set on the canvas.
 *               At this point, the clock can be started by calling
 *               `.play()` method on the component.
 *  - onSync: will be called when the presentation time offset is
 *            known, with the latter as argument (in UNIX milliseconds)
 *
 * @class CanvasComponent
 * @extends {Component}
 */
class CanvasComponent extends Component {
  /**
   * Creates an instance of CanvasComponent.
   * @param { HTMLCanvasElement } el - An HTML < canvas > element
   * @memberof CanvasComponent
   */
  constructor (el) {
    if (el === undefined) {
      throw new Error('canvas element argument missing')
    }

    let firstTimestamp = 0
    let lastTimestamp = 0
    let clockrate = 0
    let info = {}
    let updateInfo

    let ctx = el.getContext('bitmaprenderer')
    let drawImageBlob
    if (ctx !== null) {
      // The createImageBitmap function is supported in Chrome and Firefox
      // (https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/createImageBitmap)
      // Note: drawImage can also be used instead of transferFromImageBitmap, but it caused
      // very large memory use in Chrome (goes up to ~2-3GB, then drops again).
      drawImageBlob = ({blob}) => {
        info.renderedFrames++
        window.createImageBitmap(blob).then((imageBitmap) => {
          ctx.transferFromImageBitmap(imageBitmap)
        })
      }
    } else {
      ctx = el.getContext('2d')
      const img = new window.Image()
      img.onload = () => {
        ctx.drawImage(img, 0, 0)
      }
      drawImageBlob = ({blob}) => {
        info.renderedFrames++
        const url = window.URL.createObjectURL(blob)
        img.src = url
      }
    }

    // Because we don't have an element that plays video for us,
    // we have to use our own clock. The clock can be started/stopped
    // with the `play` and `pause` methods, and has a `currentTime`
    // property that keeps track of the presentation time.
    // The scheduler will use the clock (instead of e.g. a video element)
    // to determine when to display the JPEG images.
    const clock = new Clock()
    const scheduler = new Scheduler(clock, drawImageBlob)

    let ntpPresentationTime = 0
    const onCanplay = () => {
      this.onCanplay && this.onCanplay()
    }
    const onSync = (ntpPresentationTime) => {
      this.onSync && this.onSync(ntpPresentationTime)
    }

    // Set up an incoming stream and attach it to the image drawing function.
    const incoming = new Writable({
      objectMode: true,
      write: (msg, encoding, callback) => {
        if (msg.type === SDP) {
          // start of a new movie, reset timers
          clock.reset()
          scheduler.reset()

          // Initialize first timestamp and clockrate
          firstTimestamp = 0
          const jpegMedia = msg.sdp.media.find(
            media => media.type === 'video' && media.rtpmap && media.rtpmap.encodingName === 'JPEG'
          )
          clockrate = jpegMedia.rtpmap.clockrate

          // Initialize the framerate/bitrate data
          resetInfo(info)
          updateInfo = generateUpdateInfo(clockrate)

          callback()
        } else if (msg.type === JPEG) {
          const { timestamp, ntpTimestamp } = msg

          // If first frame, store its timestamp, initialize
          // the scheduler with 0 and start the clock.
          // Also set the proper size on the canvas.
          if (!firstTimestamp) {
            // Initialize timing
            firstTimestamp = timestamp
            lastTimestamp = timestamp
            // Initialize frame size
            const {width, height} = msg.framesize
            el.width = width
            el.height = height
            // Notify that we can play at this point
            scheduler.init(0)
          }
          // Compute millisecond presentation time (with offset 0
          // as we initialized the scheduler with 0).
          const presentationTime = 1000 * (timestamp - firstTimestamp) / clockrate
          const blob = new window.Blob([msg.data], { type: 'image/jpeg' })

          // If the actual UTC time of the start of presentation isn't known yet,
          // and we do have an ntpTimestamp, then compute it here and notify.
          if (!ntpPresentationTime && ntpTimestamp) {
            ntpPresentationTime = ntpTimestamp - presentationTime
            onSync(ntpPresentationTime)
          }

          scheduler.run({ntpTimestamp: presentationTime, blob})

          // Notify that we can now start the clock.
          if (timestamp === firstTimestamp) {
            onCanplay()
          }

          // Update bitrate/framerate
          updateInfo(info, {
            byteLength: msg.data.length,
            duration: timestamp - lastTimestamp
          })
          lastTimestamp = timestamp

          callback()
        } else {
          callback()
        }
      }
    })

    // Set up an outgoing stream.
    const outgoing = new Readable({
      objectMode: true,
      read: function () {
        //
      }
    })

    // When an error is sent on the outgoing stream, whine about it.
    outgoing.on('error', () => {
      console.warn('outgoing stream broke somewhere')
    })

    super(incoming, outgoing)

    this._clock = clock
    this._scheduler = scheduler
    this._info = info
  }

  /**
   * Retrieve the current presentation time (seconds)
   *
   * @readonly
   * @memberof CanvasComponent
   */
  get currentTime () {
    return this._clock.currentTime
  }

  /**
   * Pause the presentation.
   *
   * @memberof CanvasComponent
   */
  pause () {
    this._scheduler.suspend()
    this._clock.pause()
  }

  /**
   * Start the presentation.
   *
   * @memberof CanvasComponent
   */
  play () {
    this._clock.play()
    this._scheduler.resume()
  }

  get bitrate () {
    return this._info.bitrate
  }

  get framerate () {
    return this._info.framerate
  }
}

module.exports = CanvasComponent
